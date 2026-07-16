import { describe, expect, test } from "vitest";
import { createMemoryStore } from "@eveland/db";
import { decodeAgentAuthEnvelope } from "@eveland/core/agent-auth";
import { createApp } from "./app.js";

const appSecretKey = "0123456789abcdef0123456789abcdef";

describe("Agent Auth control-plane routes", () => {
  test("exposes registry descriptors and resolves an existing Project to a local-dev connection", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "connection-descriptor", importKind: "zip" });
    const app = createApp(store, { appSecretKey });

    const methodsResponse = await app.request("/agent-auth/methods");
    const connectionResponse = await app.request(`/projects/${project.id}/playground/connection`);

    expect(methodsResponse.status).toBe(200);
    await expect(methodsResponse.json()).resolves.toMatchObject({
      methods: expect.arrayContaining([
        expect.objectContaining({ method: "local-dev", credentialScope: "connection", interactive: false }),
        expect.objectContaining({ method: "bearer", credentialScope: "connection", interactive: false }),
      ]),
    });
    expect(connectionResponse.status).toBe(200);
    await expect(connectionResponse.json()).resolves.toMatchObject({
      connection: {
        target: { kind: "managed-project", projectId: project.id },
        method: "local-dev",
        securityRevision: 1,
        config: {},
      },
      status: { state: "not_required" },
    });
    expect((await store.getProjectAgentConnection(project.id))?.configEncrypted).not.toBe("{}");
  });

  test("creates the explicitly selected Agent access method with a new Project", async () => {
    const store = createMemoryStore();
    const app = createApp(store, { appSecretKey });

    const response = await app.request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "public-agent",
        importKind: "git",
        gitUrl: "https://example.com/public-agent.git",
        agentAuth: { method: "none", config: {} },
      }),
    });

    expect(response.status).toBe(201);
    const body = await response.json() as { project: { id: string }; connection: { id: string; method: string } };
    expect(body.connection).toMatchObject({ method: "none" });
    await expect(store.getProjectAgentConnection(body.project.id)).resolves.toMatchObject({
      id: body.connection.id,
      method: "none",
      securityRevision: 1,
    });
  });

  test("updates a connection with a redacted bearer configuration and never stores the token in plaintext", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "bearer-control-plane", importKind: "zip" });
    const connection = await store.createAgentConnection({
      target: { kind: "managed-project", projectId: project.id },
      method: "local-dev",
      configEncrypted: "legacy-local-dev",
    });
    const app = createApp(store, { appSecretKey });

    const response = await app.request(`/agent-connections/${connection.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedSecurityRevision: 1,
        method: "bearer",
        config: { token: "agent-token-must-stay-secret" },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      connection: {
        id: connection.id,
        target: { kind: "managed-project", projectId: project.id },
        method: "bearer",
        securityRevision: 2,
        config: { tokenConfigured: true },
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    });
    const stored = await store.getAgentConnection(connection.id);
    expect(stored?.configEncrypted).not.toContain("agent-token-must-stay-secret");
  });

  test("rejects unsafe custom credential headers before storing the connection config", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "unsafe-header", importKind: "zip" });
    const connection = await store.createAgentConnection({
      target: { kind: "managed-project", projectId: project.id },
      method: "local-dev",
      configEncrypted: "legacy-local-dev",
    });
    const app = createApp(store, { appSecretKey });

    const response = await app.request(`/agent-connections/${connection.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedSecurityRevision: 1,
        method: "headers",
        config: { headers: { Host: "attacker.example" } },
      }),
    });

    expect(response.status).toBe(422);
    await expect(store.getAgentConnection(connection.id)).resolves.toMatchObject({ method: "local-dev", securityRevision: 1 });
  });

  test("keeps a connection with an undecryptable stored config loadable and recoverable", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "undecryptable-config", importKind: "zip" });
    const connection = await store.createAgentConnection({
      target: { kind: "managed-project", projectId: project.id },
      method: "bearer",
      configEncrypted: "corrupted-not-a-valid-sealed-envelope",
    });
    const app = createApp(store, { appSecretKey });

    // The Connection dialog must still load (not 500) and report misconfigured.
    const connectionResponse = await app.request(`/projects/${project.id}/playground/connection`);
    expect(connectionResponse.status).toBe(200);
    await expect(connectionResponse.json()).resolves.toMatchObject({
      connection: { id: connection.id, method: "bearer" },
      status: { state: "misconfigured" },
    });

    // Re-saving must overwrite the broken config instead of failing on the read.
    const updated = await app.request(`/agent-connections/${connection.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedSecurityRevision: 1, method: "bearer", config: { token: "fresh-token" } }),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      connection: { method: "bearer", securityRevision: 2, config: { tokenConfigured: true } },
    });

    // `headers` must stay loadable too: its redacted view cannot assume the
    // decrypted config shape that the fallback empty config no longer has.
    const headersProject = await store.createProject({ name: "undecryptable-headers", importKind: "zip" });
    const headersConnection = await store.createAgentConnection({
      target: { kind: "managed-project", projectId: headersProject.id },
      method: "headers",
      configEncrypted: "corrupted-not-a-valid-sealed-envelope",
    });
    const headersResponse = await app.request(`/projects/${headersProject.id}/playground/connection`);
    expect(headersResponse.status).toBe(200);
    await expect(headersResponse.json()).resolves.toMatchObject({
      connection: { id: headersConnection.id, method: "headers", config: { headerNames: [] } },
      status: { state: "misconfigured" },
    });
  });

  test("sends a configured bearer credential through the canonical Playground transport", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "bearer-playground", importKind: "zip" });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/bearer-playground",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "bearer-playground",
      containerName: "bearer-playground",
      internalPort: 3000,
      hostPort: 41991,
      runtimeKind: "docker",
    });
    const connection = await store.createAgentConnection({
      target: { kind: "managed-project", projectId: project.id },
      method: "local-dev",
      configEncrypted: "legacy-local-dev",
    });
    const app = createApp(store, {
      appSecretKey,
      playgroundProxy: async (input) => {
        const encoded = (input as typeof input & { agentAuthEnvelope?: string }).agentAuthEnvelope;
        const envelope = encoded ? decodeAgentAuthEnvelope(encoded) : null;
        if (
          envelope?.authority !== "canonical" ||
          JSON.stringify(envelope.headers) !== JSON.stringify([["authorization", "Bearer protected-token"]])
        ) {
          return Response.json({ error: "Authorization is required for this route." }, { status: 401 });
        }
        return Response.json(
          { sessionId: "eve_protected", continuationToken: "continue_protected" },
          { status: 202, headers: { "x-eve-session-id": "eve_protected" } },
        );
      },
    });
    await app.request(`/agent-connections/${connection.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedSecurityRevision: 1, method: "bearer", config: { token: "protected-token" } }),
    });

    const response = await app.request(`/projects/${project.id}/playground/eve/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ sessionId: "eve_protected" });
  });

  test("authorizes the pending first turn with OIDC before sending it to the Agent exactly once", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "oidc-playground", importKind: "zip" });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/oidc-playground",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "oidc-playground",
      containerName: "oidc-playground",
      internalPort: 3000,
      hostPort: 41992,
      runtimeKind: "docker",
    });
    const connection = await store.createAgentConnection({
      target: { kind: "managed-project", projectId: project.id },
      method: "local-dev",
      configEncrypted: "legacy-local-dev",
    });
    let agentRequests = 0;
    const app = createApp(store, {
      appSecretKey,
      webOrigin: "https://eveland.example",
      oidcProtocol: {
        async preflight() {},
        async buildAuthorizationUrl(_config, transaction) {
          return new URL(`https://idp.example/authorize?state=${encodeURIComponent(transaction.state)}`);
        },
        async exchangeAuthorizationCode() {
          return {
            accessToken: "oidc-agent-token",
            refreshToken: "oidc-refresh-token",
            expiresAt: new Date("2030-01-01T00:00:00.000Z"),
            issuer: "https://idp.example",
            subject: "agent-subject-not-eveland-user",
          };
        },
        async refresh() {
          throw new Error("refresh should not run");
        },
      },
      oidcVerifyAccessToken: async () => ({ issuer: "https://idp.example", subject: "agent-subject-not-eveland-user" }),
      agentAuthNow: () => new Date("2029-01-01T00:00:00.000Z"),
      playgroundProxy: async (input) => {
        agentRequests += 1;
        const envelope = input.agentAuthEnvelope ? decodeAgentAuthEnvelope(input.agentAuthEnvelope) : null;
        if (JSON.stringify(envelope?.headers) !== JSON.stringify([["authorization", "Bearer oidc-agent-token"]])) {
          return Response.json({ error: "Authorization is required for this route." }, { status: 401 });
        }
        return Response.json({ sessionId: "eve_oidc" }, { status: 202, headers: { "x-eve-session-id": "eve_oidc" } });
      },
    });
    const configured = await app.request(`/agent-connections/${connection.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedSecurityRevision: 1,
        method: "oidc",
        config: {
          issuer: "https://idp.example",
          clientId: "eveland-playground",
          tokenEndpointAuthMethod: "none",
          audience: "https://agent.example",
        },
      }),
    });
    expect(configured.status).toBe(200);

    const first = await app.request(`/projects/${project.id}/playground/eve/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello after authorization" }),
    });
    expect(first.status).toBe(401);
    const failure = await first.json() as { interaction: { url: string } };
    expect(agentRequests).toBe(0);
    await expect(store.listSessions(project.id)).resolves.toEqual([]);

    const interactionUrl = new URL(failure.interaction.url, "https://eveland.example");
    const start = await app.request(`${interactionUrl.pathname.replace(/^\/api\/eveland/, "")}${interactionUrl.search}`);
    expect(start.status).toBe(302);
    const authorizeUrl = new URL(start.headers.get("location")!);
    const state = authorizeUrl.searchParams.get("state")!;
    const callback = await app.request(`/agent-auth/callback/oidc?code=authorization-code&state=${encodeURIComponent(state)}`);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(`https://eveland.example/projects/${project.id}/playground`);

    const resumed = await app.request(`/projects/${project.id}/playground/eve/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello after authorization" }),
    });
    expect(resumed.status).toBe(202);
    expect(agentRequests).toBe(1);
    await expect(store.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({ eveSessionId: "eve_oidc", status: "running" }),
    ]);
  });

  test("returns the Agent response when the server runtime overrides the global Response class", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "patched-global-playground", importKind: "zip" });
    // @hono/node-server's getRequestListener replaces global Response with its own
    // subclass, so fetch responses from the transport are not `instanceof Response`.
    const NativeResponse = Response;
    class PatchedResponse extends NativeResponse {}
    const app = createApp(store, {
      appSecretKey,
      playgroundProxy: async () =>
        NativeResponse.json(
          { sessionId: "eve_native" },
          { status: 202, headers: { "x-eve-session-id": "eve_native" } },
        ),
    });

    Object.defineProperty(globalThis, "Response", { value: PatchedResponse });
    try {
      const response = await app.request(`/projects/${project.id}/playground/eve/v1/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      });

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({ sessionId: "eve_native" });
    } finally {
      Object.defineProperty(globalThis, "Response", { value: NativeResponse });
    }
  });
});
