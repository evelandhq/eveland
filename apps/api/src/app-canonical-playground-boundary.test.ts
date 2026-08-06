import type { AgentAuthProviderRegistration } from "@evelandhq/agent-auth";
import { sealAgentAuthConfig } from "@evelandhq/agent-auth/sealed-config";
import type { AuthPrincipal } from "@evelandhq/core/contracts";
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
            continuationToken: "continue_focused_boundary",
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

    const response = await app.request(`/projects/${project.id}/playground/eve/v1/session`, {
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
        continuationToken: "continue_focused_boundary",
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

    const response = await app.request(`/projects/${project.id}/playground/eve/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Reject this credential twice" }),
    });

    expect(response.status).toBe(401);
    expect(playgroundProxy).toHaveBeenCalledTimes(2);
    await expect(store.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({ status: "failed", trigger: "playground" }),
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
      continuationToken: "continue_existing",
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
      `/projects/${project.id}/playground/eve/v1/session/eve_existing_continuation`,
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
        continuationToken: "continue_existing",
      }),
    ]);
  });
});
