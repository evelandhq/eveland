import { decodeAgentAuthEnvelope } from "@eveland/core/agent-auth";
import type { OidcProtocol } from "@eveland/agent-auth/oidc";
import type { AgentAuthProviderRegistration } from "@eveland/agent-auth";
import { encryptSecretValue } from "@eveland/core/server/secrets";
import { createTestStore } from "@eveland/db/vitest";
import { describe, expect, test } from "vitest";
import { createApp } from "./app.js";

const appSecretKey = "0123456789abcdef0123456789abcdef";

describe("Agent Auth control-plane routes", () => {
  test("lists generic methods and lazily creates a redacted local-dev Connection", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "connection-descriptor", importKind: "zip" });
    const app = createApp(store, { appSecretKey });

    const methods = await app.request("/agent-auth/methods");
    const response = await app.request(`/projects/${project.id}/playground/connection`);

    expect(methods.status).toBe(200);
    await expect(methods.json()).resolves.toMatchObject({
      methods: [
        expect.objectContaining({ method: "local-dev", credentialScope: "connection" }),
        expect.objectContaining({ method: "none", credentialScope: "connection" }),
        expect.objectContaining({ method: "basic", credentialScope: "connection" }),
        expect.objectContaining({ method: "bearer", credentialScope: "connection" }),
        expect.objectContaining({ method: "vercel-oidc", credentialScope: "connection" }),
        expect.objectContaining({ method: "oidc", credentialScope: "principal", interactive: true }),
        expect.objectContaining({ method: "headers", credentialScope: "connection" }),
      ],
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
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

  test("redacts secrets and only increments revision for semantic changes", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "bearer-control-plane", importKind: "zip" });
    const app = createApp(store, { appSecretKey });
    const initial = await app.request(`/projects/${project.id}/playground/connection`);
    const initialBody = await initial.json() as { connection: { id: string } };

    const configured = await app.request(`/agent-connections/${initialBody.connection.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedSecurityRevision: 1,
        method: "bearer",
        config: { token: "agent-token-must-stay-secret" },
      }),
    });
    const unchanged = await app.request(`/agent-connections/${initialBody.connection.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedSecurityRevision: 2, method: "bearer", config: {} }),
    });

    expect(configured.status).toBe(200);
    await expect(configured.json()).resolves.toMatchObject({
      connection: { method: "bearer", securityRevision: 2, config: { tokenConfigured: true } },
    });
    expect(unchanged.status).toBe(200);
    await expect(unchanged.json()).resolves.toMatchObject({ connection: { securityRevision: 2 } });
    expect((await store.getProjectAgentConnection(project.id))?.configEncrypted).not.toContain("agent-token-must-stay-secret");
  });

  test("rejects an unsafe custom credential header without changing the Connection", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "unsafe-header", importKind: "zip" });
    const app = createApp(store, { appSecretKey });
    const initial = await app.request(`/projects/${project.id}/playground/connection`);
    const body = await initial.json() as { connection: { id: string } };

    const response = await app.request(`/agent-connections/${body.connection.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedSecurityRevision: 1,
        method: "headers",
        config: { headers: { Host: "attacker.example" } },
      }),
    });

    expect(response.status).toBe(422);
    await expect(store.getProjectAgentConnection(project.id)).resolves.toMatchObject({ method: "local-dev", securityRevision: 1 });
  });

  test("resolves the current credential for every canonical Playground request", async () => {
    const store = createTestStore();
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
    const seen: string[] = [];
    const app = createApp(store, {
      appSecretKey,
      playgroundProxy: async (input) => {
        seen.push(input.agentAuthEnvelope ?? "");
        if (input.path.endsWith("/stream")) return new Response(null, { status: 200 });
        return Response.json(
          { sessionId: "eve_protected", continuationToken: "continue_protected" },
          { status: 202, headers: { "x-eve-session-id": "eve_protected" } },
        );
      },
    });
    const initial = await app.request(`/projects/${project.id}/playground/connection`);
    const body = await initial.json() as { connection: { id: string } };
    await app.request(`/agent-connections/${body.connection.id}`, {
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
    await app.request(`/agent-connections/${body.connection.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedSecurityRevision: 2, method: "bearer", config: { token: "continued-token" } }),
    });
    const continuation = await app.request(`/projects/${project.id}/playground/eve/v1/session/eve_protected`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "continue" }),
    });
    expect(continuation.status).toBe(202);
    await app.request(`/agent-connections/${body.connection.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedSecurityRevision: 3, method: "bearer", config: { token: "stream-token" } }),
    });
    const stream = await app.request(`/projects/${project.id}/playground/eve/v1/session/eve_protected/stream`);
    expect(stream.status).toBe(200);

    expect(seen.map((value) => decodeAgentAuthEnvelope(value))).toEqual([{
      version: 1,
      authority: "canonical",
      headers: [["authorization", "Bearer protected-token"]],
    }, {
      version: 1,
      authority: "canonical",
      headers: [["authorization", "Bearer continued-token"]],
    }, {
      version: 1,
      authority: "canonical",
      headers: [["authorization", "Bearer stream-token"]],
    }]);
  });

  test("holds the first turn until the OIDC callback and then sends it once", async () => {
    const store = createTestStore();
    const project = await deployedProject(store, "oidc-first-turn");
    const seen: string[] = [];
    const app = createApp(store, {
      appSecretKey,
      webOrigin: "https://eveland.example",
      oidcProtocol: mockOidcProtocol(),
      oidcVerifyAccessToken: async () => ({ issuer: "https://idp.example", subject: "agent-subject" }),
      playgroundProxy: async (input) => {
        seen.push(input.agentAuthEnvelope ?? "");
        return Response.json(
          { sessionId: "eve_oidc", continuationToken: "continue_oidc" },
          { status: 202, headers: { "x-eve-session-id": "eve_oidc" } },
        );
      },
    });
    const initial = await app.request(`/projects/${project.id}/playground/connection`);
    const connectionId = ((await initial.json()) as { connection: { id: string } }).connection.id;
    const configured = await app.request(`/agent-connections/${connectionId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedSecurityRevision: 1,
        method: "oidc",
        config: oidcConfig(),
      }),
    });
    expect(configured.status).toBe(200);

    const first = await sendInitialTurn(app, project.id);
    expect(first.status).toBe(401);
    expect(seen).toHaveLength(0);
    const failure = await first.json() as { code: string; interaction: { url: string } };
    expect(failure.code).toBe("interaction_required");
    const interactionUrl = new URL(failure.interaction.url, "https://eveland.example");
    const start = await app.request(`${interactionUrl.pathname.replace(/^\/api\/eveland/, "")}${interactionUrl.search}`);
    expect(start.status).toBe(302);
    const authorization = new URL(start.headers.get("location")!);
    const state = authorization.searchParams.get("state");
    expect(state).toBeTruthy();

    const callback = await app.request("/agent-auth/callback/oidc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ search: `?code=authorization-code&state=${encodeURIComponent(state!)}` }),
    });
    expect(callback.status).toBe(200);
    await expect(callback.json()).resolves.toEqual({ returnPath: `/projects/${project.id}/playground` });

    const resumed = await sendInitialTurn(app, project.id);
    expect(resumed.status).toBe(202);
    expect(seen).toHaveLength(1);
    expect(decodeAgentAuthEnvelope(seen[0]!)).toEqual({
      version: 1,
      authority: "canonical",
      headers: [["authorization", "Bearer oidc-access-token"]],
    });
  });

  test("refreshes and retries one OIDC 401 but never refreshes a 403", async () => {
    const store = createTestStore();
    const project = await deployedProject(store, "oidc-recovery");
    let refreshCalls = 0;
    let upstreamCalls = 0;
    let responseMode: "normal" | "forbidden" | "unauthorized" = "normal";
    const app = createApp(store, {
      appSecretKey,
      webOrigin: "https://eveland.example",
      oidcProtocol: mockOidcProtocol({
        async refresh(_config, _secret, _refreshToken, subject) {
          refreshCalls += 1;
          return {
            accessToken: "refreshed-access-token",
            refreshToken: "rotated-refresh-token",
            expiresAt: new Date("2030-01-01T00:00:00.000Z"),
            issuer: "https://idp.example",
            subject,
          };
        },
      }),
      oidcVerifyAccessToken: async () => ({ issuer: "https://idp.example", subject: "agent-subject" }),
      playgroundProxy: async (input) => {
        upstreamCalls += 1;
        const envelope = decodeAgentAuthEnvelope(input.agentAuthEnvelope ?? "");
        if (responseMode === "forbidden") return Response.json({ error: "forbidden" }, { status: 403 });
        if (responseMode === "unauthorized") return Response.json({ error: "unauthorized" }, { status: 401 });
        if (envelope.headers[0]?.[1] === "Bearer oidc-access-token") {
          return Response.json({ error: "expired" }, { status: 401 });
        }
        return Response.json(
          { sessionId: "eve_refreshed", continuationToken: "continue_refreshed" },
          { status: 202, headers: { "x-eve-session-id": "eve_refreshed" } },
        );
      },
    });
    await authorizeOidc(app, project.id);

    const recovered = await sendInitialTurn(app, project.id);
    expect(recovered.status).toBe(202);
    expect(refreshCalls).toBe(1);
    expect(upstreamCalls).toBe(2);

    responseMode = "forbidden";
    const denied = await sendInitialTurn(app, project.id);
    expect(denied.status).toBe(403);
    expect(refreshCalls).toBe(1);
    expect(upstreamCalls).toBe(3);

    responseMode = "unauthorized";
    const rejected = await sendInitialTurn(app, project.id);
    expect(rejected.status).toBe(401);
    expect(refreshCalls).toBe(2);
    expect(upstreamCalls).toBe(5);
  });

  test("delegates 401 recovery to an opaque registered provider", async () => {
    const store = createTestStore();
    const project = await deployedProject(store, "opaque-recovery");
    let generation = 1;
    let recoveryCalls = 0;
    let upstreamCalls = 0;
    const provider: AgentAuthProviderRegistration = {
      ...opaqueProvider("future-rotating"),
      async getCredential() {
        return {
          envelope: {
            version: 1 as const,
            authority: "canonical" as const,
            headers: [["authorization", `Bearer generation-${generation}`] as [string, string]],
          },
          version: { generation },
        };
      },
      async recoverUnauthorized() {
        recoveryCalls += 1;
        generation += 1;
        return { action: "retry" as const };
      },
    };
    const app = createApp(store, {
      appSecretKey,
      agentAuthProviders: [provider],
      playgroundProxy: async (input) => {
        upstreamCalls += 1;
        const credential = decodeAgentAuthEnvelope(input.agentAuthEnvelope ?? "").headers[0]?.[1];
        if (credential === "Bearer generation-1") return Response.json({ error: "expired" }, { status: 401 });
        return Response.json(
          { sessionId: "eve_opaque", continuationToken: "continue_opaque" },
          { status: 202, headers: { "x-eve-session-id": "eve_opaque" } },
        );
      },
    });
    await configureConnection(app, project.id, "future-rotating");

    const response = await sendInitialTurn(app, project.id);

    expect(response.status).toBe(202);
    expect(recoveryCalls).toBe(1);
    expect(upstreamCalls).toBe(2);
  });

  test("dispatches interaction routes through an opaque registered provider", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "opaque-interaction", importKind: "zip" });
    const provider: AgentAuthProviderRegistration = {
      ...opaqueProvider("future-interactive", true),
      interaction: {
        async start(input: { returnPath: string }) {
          return { authorizationUrl: `https://identity.example/authorize?return=${encodeURIComponent(input.returnPath)}` };
        },
        async callback() {
          return { returnPath: `/projects/${project.id}/playground` };
        },
      },
    };
    const app = createApp(store, { appSecretKey, agentAuthProviders: [provider] });
    const connectionId = await configureConnection(app, project.id, "future-interactive");

    const start = await app.request(
      `/agent-connections/${connectionId}/auth/interactions/future-interactive/start?returnPath=${encodeURIComponent(`/projects/${project.id}/playground`)}`,
    );
    const callback = await app.request("/agent-auth/callback/future-interactive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ search: "?code=opaque-code&state=opaque-state" }),
    });

    expect(start.status).toBe(302);
    expect(start.headers.get("location")).toContain("https://identity.example/authorize");
    expect(callback.status).toBe(200);
    await expect(callback.json()).resolves.toEqual({ returnPath: `/projects/${project.id}/playground` });
  });

  test("resolves the current Project Secret reference for every Agent request", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "referenced-bearer-playground", importKind: "zip" });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/referenced-bearer-playground",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "referenced-bearer-playground",
      containerName: "referenced-bearer-playground",
      internalPort: 3000,
      hostPort: 41992,
      runtimeKind: "docker",
    });
    await store.upsertSecret(project.id, "PROJECT_TOKEN", JSON.stringify(encryptSecretValue("project-token-v1", appSecretKey)));
    const catalogApp = createApp(store, { appSecretKey });
    const catalogResponse = await catalogApp.request(`/projects/${project.id}/agent-auth/secret-references`);
    expect(catalogResponse.status).toBe(200);
    const catalog = await catalogResponse.json();
    expect(catalog).toEqual({ references: [
      { kind: "project-secret", key: "PROJECT_TOKEN", label: "Project Secret · PROJECT_TOKEN" },
    ] });
    expect(JSON.stringify(catalog)).not.toContain("project-token-v1");
    const seen: string[] = [];
    const app = createApp(store, {
      appSecretKey,
      playgroundProxy: async (input) => {
        seen.push(input.agentAuthEnvelope ?? "");
        return Response.json(
          { sessionId: `eve_reference_${seen.length}`, continuationToken: `continue_reference_${seen.length}` },
          { status: 202, headers: { "x-eve-session-id": `eve_reference_${seen.length}` } },
        );
      },
    });
    const initial = await app.request(`/projects/${project.id}/playground/connection`);
    const body = await initial.json() as { connection: { id: string } };

    await app.request(`/agent-connections/${body.connection.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedSecurityRevision: 1,
        method: "bearer",
        config: { tokenRef: { kind: "project-secret", key: "PROJECT_TOKEN" } },
      }),
    });
    await app.request(`/projects/${project.id}/playground/eve/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "project reference" }),
    });

    await app.request(`/agent-connections/${body.connection.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedSecurityRevision: 2,
        method: "bearer",
        config: { tokenRef: { kind: "project-secret", key: "PROJECT_TOKEN" } },
      }),
    });
    await store.upsertSecret(project.id, "PROJECT_TOKEN", JSON.stringify(encryptSecretValue("project-token-v2", appSecretKey)));
    await app.request(`/projects/${project.id}/playground/eve/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "rotated project reference" }),
    });

    expect(seen.map((encoded) => decodeAgentAuthEnvelope(encoded).headers)).toEqual([
      [["authorization", "Bearer project-token-v1"]],
      [["authorization", "Bearer project-token-v2"]],
    ]);
  });

  test("resolves a Project Secret for confidential OIDC preflight", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "project-oidc-client", importKind: "zip" });
    await store.upsertSecret(
      project.id,
      "OIDC_CLIENT_SECRET",
      JSON.stringify(encryptSecretValue("project-client-secret", appSecretKey)),
    );
    let preflightSecret: string | undefined;
    const app = createApp(store, {
      appSecretKey,
      oidcProtocol: mockOidcProtocol({
        async preflight(_config, clientSecret) {
          preflightSecret = clientSecret;
        },
      }),
    });
    const initial = await app.request(`/projects/${project.id}/playground/connection`);
    const connectionId = ((await initial.json()) as { connection: { id: string } }).connection.id;

    const configured = await app.request(`/agent-connections/${connectionId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedSecurityRevision: 1,
        method: "oidc",
        config: {
          ...oidcConfig(),
          tokenEndpointAuthMethod: "client_secret_post",
          clientSecretRef: { kind: "project-secret", key: "OIDC_CLIENT_SECRET" },
        },
      }),
    });

    expect(configured.status).toBe(200);
    expect(preflightSecret).toBe("project-client-secret");
    await expect(configured.json()).resolves.toMatchObject({
      connection: { config: { clientSecretConfigured: true } },
    });
  });
});

function oidcConfig() {
  return {
    issuer: "https://idp.example",
    clientId: "eveland-playground",
    scopes: ["openid", "offline_access"],
    audience: "https://agent.example",
    audienceMode: "resource",
    tokenEndpointAuthMethod: "none",
    accessTokenVerification: "eve-jwt",
  };
}

function mockOidcProtocol(overrides: Partial<OidcProtocol> = {}): OidcProtocol {
  return {
    async preflight() {},
    async buildAuthorizationUrl(_config, _secret, transaction) {
      return new URL(`https://idp.example/authorize?state=${transaction.state}`);
    },
    async exchangeAuthorizationCode() {
      return {
        accessToken: "oidc-access-token",
        refreshToken: "oidc-refresh-token",
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        issuer: "https://idp.example",
        subject: "id-token-subject",
      };
    },
    async refresh() { throw new Error("refresh should not run"); },
    async fetchUserInfo() { return { subject: "id-token-subject" }; },
    ...overrides,
  };
}

async function deployedProject(store: ReturnType<typeof createTestStore>, name: string) {
  const project = await store.createProject({ name, importKind: "zip" });
  const revision = await store.recordSourceRevision({
    projectId: project.id,
    kind: "zip",
    sourcePath: `/tmp/${name}`,
    summary: {},
    envVars: [],
    files: [],
    schedules: [],
  });
  await store.recordDeployment({
    projectId: project.id,
    sourceRevisionId: revision.id,
    imageTag: name,
    containerName: name,
    internalPort: 3000,
    hostPort: 41992,
    runtimeKind: "docker",
  });
  return project;
}

function sendInitialTurn(app: ReturnType<typeof createApp>, projectId: string) {
  return app.request(`/projects/${projectId}/playground/eve/v1/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hello" }),
  });
}

async function authorizeOidc(app: ReturnType<typeof createApp>, projectId: string) {
  const initial = await app.request(`/projects/${projectId}/playground/connection`);
  const connectionId = ((await initial.json()) as { connection: { id: string } }).connection.id;
  const configured = await app.request(`/agent-connections/${connectionId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedSecurityRevision: 1, method: "oidc", config: oidcConfig() }),
  });
  expect(configured.status).toBe(200);
  const first = await sendInitialTurn(app, projectId);
  const failure = await first.json() as { interaction: { url: string } };
  const interaction = new URL(failure.interaction.url, "https://eveland.example");
  const start = await app.request(`${interaction.pathname.replace(/^\/api\/eveland/, "")}${interaction.search}`);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const callback = await app.request("/agent-auth/callback/oidc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ search: `?code=code&state=${encodeURIComponent(state)}` }),
  });
  expect(callback.status).toBe(200);
}

function opaqueProvider(method: string, interactive = false) {
  return {
    method,
    descriptor: {
      method,
      label: method,
      description: "Test provider whose method is opaque to the API.",
      credentialScope: "principal" as const,
      interactive,
      fields: [],
    },
    credentialScope: "principal" as const,
    authority: "canonical" as const,
    normalizeConfig() { return {}; },
    redactConfig() { return {}; },
    async getCredential() {
      return {
        envelope: { version: 1 as const, authority: "canonical" as const, headers: [] },
        version: null,
      };
    },
  };
}

async function configureConnection(app: ReturnType<typeof createApp>, projectId: string, method: string): Promise<string> {
  const initial = await app.request(`/projects/${projectId}/playground/connection`);
  const connectionId = ((await initial.json()) as { connection: { id: string } }).connection.id;
  const configured = await app.request(`/agent-connections/${connectionId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedSecurityRevision: 1, method, config: {} }),
  });
  expect(configured.status).toBe(200);
  return connectionId;
}
