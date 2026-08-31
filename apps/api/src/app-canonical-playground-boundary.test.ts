import type { AgentAuthProviderRegistration } from "@evelandhq/agent-auth";
import { sealAgentAuthConfig } from "@evelandhq/agent-auth/sealed-config";
import type { AuthPrincipal } from "@evelandhq/core/contracts";
import { PLAYGROUND_OPERATION_ID_HEADER } from "@evelandhq/core/eve";
import { createId } from "@evelandhq/core/ids";
import { createTestStore } from "@evelandhq/db/vitest";
import { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";
import { createAgentAuthService } from "./agent-auth-service.js";
import { registerCanonicalPlaygroundRoute } from "./app-canonical-playground-route.js";

const appSecretKey = "0123456789abcdef0123456789abcdef";

async function createRecoverableAgentAuth(
  store: ReturnType<typeof createTestStore>,
  projectId: string,
  terminalAction: "give_up" | "retry",
) {
  const provider: AgentAuthProviderRegistration = {
    method: "test-recoverable",
    descriptor: {
      method: "test-recoverable",
      label: "Test recoverable credential",
      description: "Exercises terminal credential rejection.",
      credentialScope: "connection",
      interactive: false,
      fields: [],
    },
    credentialScope: "connection",
    authority: "canonical",
    normalizeConfig: () => ({}),
    redactConfig: () => ({}),
    async getCredential() {
      return {
        envelope: {
          version: 1,
          authority: "canonical",
          headers: [["authorization", "Bearer rejected"]],
        },
        version: 1,
      };
    },
    async recoverUnauthorized({ attempt }) {
      if (attempt === 0 || terminalAction === "retry") {
        return { action: "retry" };
      }
      return {
        action: "give_up",
        failure: {
          code: "credential_rejected",
          method: "test-recoverable",
          message: "The recovered credential was rejected.",
        },
      };
    },
  };
  const connectionId = createId("acon");
  await store.createAgentConnection({
    id: connectionId,
    target: { kind: "managed-project", projectId },
    method: provider.method,
    configEncrypted: sealAgentAuthConfig({}, appSecretKey, {
      agentConnectionId: connectionId,
      method: provider.method,
      securityRevision: 1,
    }),
  });
  return createAgentAuthService({
    store,
    appSecretKey,
    oidcCallbackUrl: "http://localhost:3000/agent-auth/oidc/callback",
    agentAuthProviders: [provider],
  });
}

describe("canonical Playground API boundary", () => {
  test("registers the transport route against focused auth and persistence ports", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "focused-canonical-playground-boundary",
      importKind: "zip",
    });
    const app = new Hono<{ Variables: { principal: AuthPrincipal } }>();
    const agentAuth = createAgentAuthService({
      store,
      appSecretKey,
      oidcCallbackUrl: "http://localhost:3000/agent-auth/oidc/callback",
    });
    const playgroundProxy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            sessionId: "eve_focused_boundary",
          }),
          {
            status: 202,
            headers: {
              "content-type": "application/json",
              "x-eve-session-id": "eve_focused_boundary",
            },
          },
        ),
    );
    registerCanonicalPlaygroundRoute({
      app,
      store,
      agentAuth,
      playgroundProxy,
    });

    const response = await app.request(`/api/projects/${project.id}/playground/eve/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Exercise the focused boundary" }),
    });

    expect(response.status).toBe(202);
    expect(playgroundProxy).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: project.id,
        path: "/eve/v1/session",
        method: "POST",
        agentAuthEnvelope: expect.any(String),
      }),
    );
    await expect(store.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({
        eveSessionId: "eve_focused_boundary",
        status: "running",
        trigger: "playground",
      }),
    ]);
  });

  test("fails a new platform Session when a recovered credential is rejected twice", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "terminal-credential-rejection",
      importKind: "zip",
    });
    const agentAuth = await createRecoverableAgentAuth(store, project.id, "give_up");
    const playgroundProxy = vi.fn(async () => new Response(null, { status: 401 }));
    const app = new Hono<{ Variables: { principal: AuthPrincipal } }>();
    registerCanonicalPlaygroundRoute({
      app,
      store,
      agentAuth,
      playgroundProxy,
    });

    const response = await app.request(`/api/projects/${project.id}/playground/eve/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Reject this credential twice" }),
    });

    expect(response.status).toBe(401);
    expect(playgroundProxy).toHaveBeenCalledTimes(2);
    await expect(store.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({
        status: "failed",
        trigger: "playground",
        error: expect.stringContaining("The turn was not delivered"),
      }),
    ]);
  });

  test("stores the upstream rejection reason on the failed Session", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "upstream-rejection-reason",
      importKind: "zip",
    });
    const app = new Hono<{ Variables: { principal: AuthPrincipal } }>();
    const agentAuth = createAgentAuthService({
      store,
      appSecretKey,
      oidcCallbackUrl: "http://localhost:3000/agent-auth/oidc/callback",
    });
    // The gateway's activation rejection, detail included (#294): the body
    // must survive into the stored reason, not just stream to the browser.
    const playgroundProxy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: "Deployment activation failed",
            detail: "Control API activation failed with HTTP 504: Runtime activation timed out.",
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
    );
    registerCanonicalPlaygroundRoute({ app, store, agentAuth, playgroundProxy });

    const response = await app.request(`/api/projects/${project.id}/playground/eve/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Hit a cold deployment" }),
    });

    expect(response.status).toBe(503);
    // The browser still receives the upstream body untouched.
    await expect(response.json()).resolves.toMatchObject({
      error: "Deployment activation failed",
    });
    await expect(store.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({
        status: "failed",
        error:
          "The turn failed upstream with HTTP 503: Deployment activation failed: " +
          "Control API activation failed with HTTP 504: Runtime activation timed out.",
      }),
    ]);
  });

  test("stores a reason when the turn never reaches the gateway", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "proxy-connection-failure",
      importKind: "zip",
    });
    const app = new Hono<{ Variables: { principal: AuthPrincipal } }>();
    const agentAuth = createAgentAuthService({
      store,
      appSecretKey,
      oidcCallbackUrl: "http://localhost:3000/agent-auth/oidc/callback",
    });
    const playgroundProxy = vi.fn(async () => {
      throw new Error("fetch failed: connect ECONNREFUSED 127.0.0.1:4080");
    });
    registerCanonicalPlaygroundRoute({ app, store, agentAuth, playgroundProxy });

    const response = await app.request(`/api/projects/${project.id}/playground/eve/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Nobody is listening" }),
    });

    expect(response.status).toBe(502);
    await expect(store.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({
        status: "failed",
        error:
          "The turn never reached the agent: fetch failed: connect ECONNREFUSED 127.0.0.1:4080",
      }),
    ]);
  });

  test("preserves continuation identity when terminal recovery still asks to retry", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "terminal-continuation-retry",
      importKind: "zip",
    });
    const existingSession = await store.createSession({
      projectId: project.id,
      trigger: "playground",
      eveSessionId: "eve_existing_continuation",
    });
    const agentAuth = await createRecoverableAgentAuth(store, project.id, "retry");
    const playgroundProxy = vi.fn(async () => new Response(null, { status: 401 }));
    const app = new Hono<{ Variables: { principal: AuthPrincipal } }>();
    registerCanonicalPlaygroundRoute({
      app,
      store,
      agentAuth,
      playgroundProxy,
    });

    const response = await app.request(
      `/api/projects/${project.id}/playground/eve/v1/session/eve_existing_continuation`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Continue with rejected credentials" }),
      },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "retry_required",
      method: "test-recoverable",
    });
    expect(playgroundProxy).toHaveBeenCalledTimes(2);
    await expect(store.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({
        id: existingSession.id,
        status: "failed",
        eveSessionId: "eve_existing_continuation",
      }),
    ]);
  });
});

describe("canonical Playground create-once operation identity (#407)", () => {
  function createOnceHarness(handleCreate: (body: Record<string, unknown>) => Response) {
    const store = createTestStore();
    const app = new Hono<{ Variables: { principal: AuthPrincipal } }>();
    const agentAuth = createAgentAuthService({
      store,
      appSecretKey,
      oidcCallbackUrl: "http://localhost:3000/agent-auth/oidc/callback",
    });
    const observedBodies: Record<string, unknown>[] = [];
    const playgroundProxy = vi.fn(async (input: { body: Uint8Array | null }) => {
      const body = JSON.parse(new TextDecoder().decode(input.body ?? new Uint8Array())) as Record<
        string,
        unknown
      >;
      observedBodies.push(body);
      return handleCreate(body);
    });
    registerCanonicalPlaygroundRoute({ app, store, agentAuth, playgroundProxy });
    return { store, app, playgroundProxy, observedBodies };
  }

  const acceptedCreate = (sessionId: string) =>
    new Response(JSON.stringify({ ok: true, sessionId, status: "accepted" }), {
      status: 202,
      headers: { "content-type": "application/json", "x-eve-session-id": sessionId },
    });

  test("keeps one operation identity across an ambiguous create and its retry", async () => {
    // Regression for the stable-deployment readiness timeout: Eve collapses
    // the 30s command-hook wait into an opaque 500 while the workflow may
    // already be committed. The retry must carry the identical operationId so
    // Eve adopts the committed Session instead of executing the input twice.
    let calls = 0;
    const { store, app, observedBodies } = createOnceHarness(() => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            error: "Failed to create the session.",
            errorId: "0e4866c1-33c2-4c58-a077-bbe4bd12b8b1",
            ok: false,
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
      return acceptedCreate("eve_adopted");
    });
    const project = await store.createProject({
      name: "create-once-ambiguous-retry",
      importKind: "zip",
    });
    const request = () =>
      app.request(`/api/projects/${project.id}/playground/eve/v1/session`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [PLAYGROUND_OPERATION_ID_HEADER]: "op-create-once",
        },
        body: JSON.stringify({ message: "Run the report" }),
      });

    const first = await request();
    expect(first.status).toBe(500);
    const second = await request();
    expect(second.status).toBe(202);

    expect(observedBodies.map((body) => body.operationId)).toEqual([
      "op-create-once",
      "op-create-once",
    ]);
    const sessions = await store.listSessions(project.id);
    expect(sessions).toHaveLength(2);
    expect(sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "failed",
          error: expect.stringContaining(
            "unknown (Eve error 0e4866c1-33c2-4c58-a077-bbe4bd12b8b1)",
          ),
        }),
        expect.objectContaining({ status: "running", eveSessionId: "eve_adopted" }),
      ]),
    );
  });

  test("replays the create without the operation id when Eve refuses anonymous principals", async () => {
    const { store, app, playgroundProxy, observedBodies } = createOnceHarness((body) => {
      if (body.operationId !== undefined) {
        return new Response(
          JSON.stringify({ error: "operationId requires an authenticated principal.", ok: false }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      return acceptedCreate("eve_anonymous");
    });
    const project = await store.createProject({
      name: "create-once-anonymous-fallback",
      importKind: "zip",
    });

    const response = await app.request(`/api/projects/${project.id}/playground/eve/v1/session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [PLAYGROUND_OPERATION_ID_HEADER]: "op-anonymous",
      },
      body: JSON.stringify({ message: "Hello" }),
    });

    expect(response.status).toBe(202);
    expect(playgroundProxy).toHaveBeenCalledTimes(2);
    expect(observedBodies.map((body) => body.operationId)).toEqual(["op-anonymous", undefined]);
    await expect(store.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({ status: "running", eveSessionId: "eve_anonymous" }),
    ]);
  });

  test("rejects a malformed operation id before proxying", async () => {
    const { store, app, playgroundProxy } = createOnceHarness(() => acceptedCreate("eve_unused"));
    const project = await store.createProject({
      name: "create-once-malformed-id",
      importKind: "zip",
    });

    const response = await app.request(`/api/projects/${project.id}/playground/eve/v1/session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [PLAYGROUND_OPERATION_ID_HEADER]: "bad id with spaces",
      },
      body: JSON.stringify({ message: "Hello" }),
    });

    expect(response.status).toBe(400);
    expect(playgroundProxy).not.toHaveBeenCalled();
    await expect(store.listSessions(project.id)).resolves.toEqual([]);
  });

  test("closes the placeholder instead of double-tracking an adopted Session", async () => {
    // A create whose response was lost can still have completed server-side;
    // the retry then adopts the same Eve Session. The platform must not end
    // up with two live rows pointing at one Eve Session.
    const { store, app } = createOnceHarness(() => acceptedCreate("eve_shared"));
    const project = await store.createProject({
      name: "create-once-adoption-dedupe",
      importKind: "zip",
    });
    const request = () =>
      app.request(`/api/projects/${project.id}/playground/eve/v1/session`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [PLAYGROUND_OPERATION_ID_HEADER]: "op-adopted-twice",
        },
        body: JSON.stringify({ message: "Hello" }),
      });

    expect((await request()).status).toBe(202);
    expect((await request()).status).toBe(202);

    const sessions = await store.listSessions(project.id);
    expect(sessions.filter((session) => session.eveSessionId === "eve_shared")).toHaveLength(1);
    expect(sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "running", eveSessionId: "eve_shared" }),
        expect.objectContaining({ status: "completed", eveSessionId: null }),
      ]),
    );
  });
});
