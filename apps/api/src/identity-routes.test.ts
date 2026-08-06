import { describe, expect, onTestFinished, test } from "vitest";
import {
  authAccounts,
  authSessions,
  authVerifications,
  invitations,
  teamMemberships,
  teams,
  users,
} from "@evelandhq/db/schema";
import { createPgliteTestStore, disableSeededOpenIdentityProvider } from "@evelandhq/db/test";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createApp } from "./app.js";
import { createBetterAuthRuntime } from "./auth.js";

const webOrigin = "http://localhost:3000";
const apiOrigin = "http://localhost:4000";
const chatOrigin = "http://localhost:3010";
const appSecretKey = "identity-api-secret-key-00000000";

async function createIdentityApp({ keepOpenAccess = false } = {}) {
  const database = await createPgliteTestStore();
  onTestFinished(() => database.close());
  const auth = createBetterAuthRuntime({
    database: drizzleAdapter(database.db, {
      provider: "pg",
      schema: {
        user: users,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
        organization: teams,
        member: teamMemberships,
        invitation: invitations,
      },
    }),
    baseURL: apiOrigin,
    webOrigin,
    secret: "test-secret-with-at-least-thirty-two-characters",
  });
  await auth.bootstrapDefaultAdmin({
    email: "admin@example.com",
    name: "测试用户",
    password: "admin-password",
  });
  await database.store.upsertIdentityReturnTarget({
    key: "eve-chats",
    origin: chatOrigin,
    enabled: true,
  });
  // Most of these tests describe an instance configured for Eveland Internal,
  // so they start from the seeded open-access Provider being switched off.
  if (!keepOpenAccess) await disableSeededOpenIdentityProvider(database.store);
  return {
    app: createApp(database.store, {
      auth,
      webOrigin,
      appSecretKey,
      identityIssuer: apiOrigin,
      identityAllowedOrigins: [chatOrigin],
      gatewayServiceToken: "gateway-service-token",
    }),
    store: database.store,
  };
}

async function signIn(app: ReturnType<typeof createApp>) {
  const response = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: webOrigin,
    },
    body: JSON.stringify({
      email: "admin@example.com",
      password: "admin-password",
    }),
  });
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}

describe("Eveland Internal Identity routes", () => {
  test("does not grant the web-chat origin CORS access to control-plane routes", async () => {
    const { app } = await createIdentityApp();
    const controlCookie = await signIn(app);

    const response = await app.request("/auth/session", {
      headers: {
        cookie: controlCookie,
        origin: chatOrigin,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("removes expired login transactions when starting a public login", async () => {
    const { app, store } = await createIdentityApp();
    const provider = await store.createIdentityProviderConnection({
      type: "internal",
      displayName: "Internal",
      internalRealmKey: "members",
      enabled: true,
    });
    const [target] = await store.listIdentityReturnTargets();
    await store.createIdentityLoginTransaction({
      stateHash: "sha256:expired-state",
      providerConnectionId: provider.id,
      providerSecurityRevision: provider.securityRevision,
      returnTargetId: target!.id,
      returnPath: "/agents/old",
      nonceHash: null,
      pkceVerifierEncrypted: null,
      expiresAt: new Date("2020-01-01T00:00:00.000Z"),
    });

    const response = await app.request(
      "/identity/login?target=eve-chats&returnPath=%2Fagents%2Fnew",
      { redirect: "manual" },
    );

    expect(response.status).toBe(302);
    await expect(
      store.consumeIdentityLoginTransaction(
        "sha256:expired-state",
        new Date("2019-01-01T00:00:00.000Z"),
      ),
    ).resolves.toBeNull();
  });

  test("lets only an admin configure one Internal provider and its Realm", async () => {
    const { app } = await createIdentityApp();
    const cookie = await signIn(app);

    const providerResponse = await app.request("/system/identity/providers", {
      method: "POST",
      headers: {
        cookie,
        origin: webOrigin,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "internal",
        displayName: "Eveland Internal",
        internalRealmKey: "eveland-members",
        enabled: true,
      }),
    });
    const providerBody = (await providerResponse.json()) as {
      provider: { id: string; internalRealmKey: string; securityRevision: number };
    };

    expect(providerResponse.status).toBe(201);
    expect(providerBody.provider).toMatchObject({
      id: expect.stringMatching(/^idpc_/),
      internalRealmKey: "eveland-members",
      securityRevision: 1,
    });
    expect(JSON.stringify(providerBody)).not.toContain("eveland_session");

    const duplicate = await app.request("/system/identity/providers", {
      method: "POST",
      headers: { cookie, origin: webOrigin, "content-type": "application/json" },
      body: JSON.stringify({
        type: "internal",
        displayName: "Another Internal",
        internalRealmKey: "other",
        enabled: true,
      }),
    });
    expect(duplicate.status).toBe(409);

    const disabledProvider = await app.request("/system/identity/providers", {
      method: "POST",
      headers: { cookie, origin: webOrigin, "content-type": "application/json" },
      body: JSON.stringify({
        type: "internal",
        displayName: "Disabled Internal",
        internalRealmKey: "disabled-members",
        enabled: false,
      }),
    });
    const disabledProviderBody = (await disabledProvider.json()) as {
      provider: { id: string; securityRevision: number };
    };
    expect(disabledProvider.status).toBe(201);
    const enableSecond = await app.request(
      `/system/identity/providers/${disabledProviderBody.provider.id}`,
      {
        method: "PATCH",
        headers: { cookie, origin: webOrigin, "content-type": "application/json" },
        body: JSON.stringify({
          expectedSecurityRevision: disabledProviderBody.provider.securityRevision,
          displayName: "Disabled Internal",
          enabled: true,
        }),
      },
    );
    expect(enableSecond.status).toBe(409);

    const realmResponse = await app.request("/system/identity/realms", {
      method: "POST",
      headers: { cookie, origin: webOrigin, "content-type": "application/json" },
      body: JSON.stringify({
        providerConnectionId: providerBody.provider.id,
        externalRealmId: "eveland-members",
        externalRealmKind: "internal",
        displayName: "Eveland Members",
        enabled: true,
      }),
    });
    const realmBody = (await realmResponse.json()) as { realm: { id: string } };
    expect(realmResponse.status).toBe(201);

    const disabledRealm = await app.request(`/system/identity/realms/${realmBody.realm.id}`, {
      method: "PATCH",
      headers: { cookie, origin: webOrigin, "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "Eveland Members",
        enabled: false,
      }),
    });
    expect(disabledRealm.status).toBe(200);
    await expect(disabledRealm.json()).resolves.toMatchObject({
      realm: { id: realmBody.realm.id, enabled: false },
    });

    const immutable = await app.request(`/system/identity/providers/${providerBody.provider.id}`, {
      method: "PATCH",
      headers: { cookie, origin: webOrigin, "content-type": "application/json" },
      body: JSON.stringify({
        expectedSecurityRevision: 1,
        displayName: "Eveland Internal",
        internalRealmKey: "rewritten",
        enabled: true,
      }),
    });
    expect(immutable.status).toBe(409);

    const savedTarget = await app.request("/system/identity/return-targets/eve-chats", {
      method: "PUT",
      headers: { cookie, origin: webOrigin, "content-type": "application/json" },
      body: JSON.stringify({ origin: "https://chat.example.com", enabled: true }),
    });
    expect(savedTarget.status).toBe(200);
    await expect(savedTarget.json()).resolves.toMatchObject({
      target: {
        key: "eve-chats",
        origin: "https://chat.example.com",
        enabled: true,
      },
    });
    const targets = await app.request("/system/identity/return-targets", {
      headers: { cookie },
    });
    await expect(targets.json()).resolves.toMatchObject({
      targets: [
        expect.objectContaining({
          key: "eve-chats",
          origin: "https://chat.example.com",
        }),
      ],
    });
    expect(
      (
        await app.request("/system/identity/return-targets/eve-chats", {
          method: "PUT",
          headers: { cookie, origin: webOrigin, "content-type": "application/json" },
          body: JSON.stringify({
            origin: "https://chat.example.com/not-an-origin",
            enabled: true,
          }),
        })
      ).status,
    ).toBe(400);
  });

  test("redirects through Eveland login, then maps only the verified Better Auth user", async () => {
    const { app, store } = await createIdentityApp();
    const connection = await store.createIdentityProviderConnection({
      type: "internal",
      displayName: "Eveland Internal",
      internalRealmKey: "eveland-members",
      enabled: true,
    });
    const realm = await store.createIdentityRealm({
      providerConnectionId: connection.id,
      externalRealmId: "eveland-members",
      externalRealmKind: "internal",
      displayName: "Eveland Members",
      enabled: true,
    });

    const login = await app.request(
      "/identity/login?target=eve-chats&returnPath=%2Fagents%2Fagent_123&userId=attacker&realm=other",
      { redirect: "manual" },
    );
    expect(login.status).toBe(302);
    const loginLocation = new URL(login.headers.get("location")!);
    expect(loginLocation.origin).toBe(webOrigin);
    expect(loginLocation.pathname).toBe("/login");
    const continuation = new URL(loginLocation.searchParams.get("next")!, webOrigin);
    expect(continuation.pathname).toBe("/identity/internal/continue");
    const state = continuation.searchParams.get("state");
    expect(state).toBeTruthy();

    const controlCookie = await signIn(app);
    const continued = await app.request(
      `/identity/internal/continue?state=${encodeURIComponent(state!)}`,
      {
        headers: { cookie: controlCookie },
        redirect: "manual",
      },
    );

    expect(continued.status).toBe(302);
    expect(continued.headers.get("location")).toBe(`${chatOrigin}/agents/agent_123`);
    const replayed = await app.request(
      `/identity/internal/continue?state=${encodeURIComponent(state!)}`,
      {
        headers: { cookie: controlCookie },
        redirect: "manual",
      },
    );
    expect(replayed.status).toBe(400);
    await expect(replayed.json()).resolves.toMatchObject({
      code: "identity_login_transaction_invalid",
    });
    const identitySetCookie = continued.headers.get("set-cookie")!;
    expect(identitySetCookie).toContain("eveland_identity=");
    expect(identitySetCookie).toContain("HttpOnly");
    expect(identitySetCookie).toContain("SameSite=Lax");
    expect(identitySetCookie).toContain("Path=/identity");
    expect(identitySetCookie).not.toContain("eveland_session=");
    const identityCookie = identitySetCookie.split(";", 1)[0]!;

    const session = await app.request("/identity/session", {
      headers: { cookie: identityCookie, origin: chatOrigin },
    });
    expect(session.status).toBe(200);
    expect(session.headers.get("access-control-allow-origin")).toBe(chatOrigin);
    expect(session.headers.get("access-control-allow-credentials")).toBe("true");
    await expect(session.json()).resolves.toEqual({
      authenticated: true,
      principal: expect.objectContaining({
        id: expect.stringMatching(/^iprn_/),
        name: "测试用户",
        email: "admin@example.com",
      }),
      activeRealm: {
        id: realm.id,
        name: "Eveland Members",
      },
    });
    expect(
      JSON.stringify(
        await store.getActiveIdentitySession(
          (await store.getActiveIdentitySession("", new Date()))?.tokenHash ?? "",
        ),
      ),
    ).not.toContain(controlCookie);
  });

  test("reuses an existing Identity session and issues Caller Tokens without Project grants", async () => {
    const { app, store } = await createIdentityApp();
    const project = await store.createProject({ name: "private-agent", importKind: "zip" });
    const connection = await store.createIdentityProviderConnection({
      type: "internal",
      displayName: "Internal",
      internalRealmKey: "members",
      enabled: true,
    });
    await store.createIdentityRealm({
      providerConnectionId: connection.id,
      externalRealmId: "members",
      externalRealmKind: "internal",
      displayName: "Members",
      enabled: true,
    });
    const controlCookie = await signIn(app);
    const login = await app.request(
      "/identity/login?target=eve-chats&returnPath=%2Fagents%2Fagent_123",
      { headers: { cookie: controlCookie }, redirect: "manual" },
    );
    const identityCookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    expect(login.headers.get("location")).toBe(`${chatOrigin}/agents/agent_123`);

    const reused = await app.request(
      "/identity/login?target=eve-chats&returnPath=%2Fagents%2Fagent_456",
      { headers: { cookie: identityCookie }, redirect: "manual" },
    );
    expect(reused.headers.get("location")).toBe(`${chatOrigin}/agents/agent_456`);
    expect(reused.headers.get("set-cookie")).toBeNull();

    const switched = await app.request(
      "/identity/login?target=eve-chats&returnPath=%2Fagents%2Fagent_456&switchRealm=1",
      {
        headers: { cookie: `${identityCookie}; ${controlCookie}` },
        redirect: "manual",
      },
    );
    expect(switched.status).toBe(302);
    expect(switched.headers.get("location")).toBe(`${chatOrigin}/agents/agent_456`);
    const rotatedIdentityCookie = switched.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    expect(rotatedIdentityCookie).not.toBe(identityCookie);
    expect(
      (
        await app.request("/identity/session", {
          headers: { cookie: identityCookie },
        })
      ).status,
    ).toBe(200);
    await expect(
      (
        await app.request("/identity/session", {
          headers: { cookie: identityCookie },
        })
      ).json(),
    ).resolves.toEqual({ authenticated: false });

    const issued = await app.request("/identity/caller-tokens", {
      method: "POST",
      headers: {
        cookie: rotatedIdentityCookie,
        origin: chatOrigin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ projectId: project.id }),
    });
    expect(issued.status).toBe(200);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    await expect(issued.json()).resolves.toMatchObject({
      token: expect.stringMatching(/^[^.]+\.[^.]+\.[^.]+$/),
    });
  });

  test("issues no-store project-bound tokens with exact CORS and supports logout", async () => {
    const { app, store } = await createIdentityApp();
    const project = await store.createProject({ name: "allowed-agent", importKind: "zip" });
    const connection = await store.createIdentityProviderConnection({
      type: "internal",
      displayName: "Internal",
      internalRealmKey: "members",
      enabled: true,
    });
    await store.createIdentityRealm({
      providerConnectionId: connection.id,
      externalRealmId: "members",
      externalRealmKind: "internal",
      displayName: "Members",
      enabled: true,
    });
    const controlCookie = await signIn(app);
    const login = await app.request(
      "/identity/login?target=eve-chats&returnPath=%2Fagents%2Fagent_123",
      { headers: { cookie: controlCookie }, redirect: "manual" },
    );
    const identityCookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";

    const disallowedOrigin = await app.request("/identity/caller-tokens", {
      method: "POST",
      headers: {
        cookie: identityCookie,
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ projectId: project.id }),
    });
    expect(disallowedOrigin.status).toBe(403);
    expect(disallowedOrigin.headers.get("access-control-allow-origin")).not.toBe(
      "https://evil.example",
    );

    const issued = await app.request("/identity/caller-tokens", {
      method: "POST",
      headers: {
        cookie: identityCookie,
        origin: chatOrigin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ projectId: project.id }),
    });
    const issuedBody = (await issued.json()) as { token: string };
    expect(issued.status).toBe(200);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    expect(issuedBody.token.split(".")).toHaveLength(3);
    expect((await app.request("/.well-known/jwks.json")).status).toBe(200);

    const logout = await app.request("/identity/logout", {
      method: "POST",
      headers: { cookie: identityCookie, origin: chatOrigin },
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(logout.headers.get("set-cookie")).toContain("Path=/identity");
    expect(
      (
        await app.request("/identity/caller-tokens", {
          method: "POST",
          headers: {
            cookie: identityCookie,
            origin: chatOrigin,
            "content-type": "application/json",
          },
          body: JSON.stringify({ projectId: project.id }),
        })
      ).status,
    ).toBe(401);
  });

  test("returns stable eveChat deployments without Realm Project grants", async () => {
    const { app, store } = await createIdentityApp();
    const connection = await store.createIdentityProviderConnection({
      type: "internal",
      displayName: "Internal",
      internalRealmKey: "members",
      enabled: true,
    });
    await store.createIdentityRealm({
      providerConnectionId: connection.id,
      externalRealmId: "members",
      externalRealmKind: "internal",
      displayName: "Members",
      enabled: true,
    });
    const chatProject = await store.createProject({
      name: "Catalog Chat",
      importKind: "zip",
    });
    await store.updateProjectMetadata(chatProject.id, {
      name: "Catalog Chat",
      description: "Answers catalog questions.",
    });
    const deployedRevision = await store.recordSourceRevision({
      projectId: chatProject.id,
      kind: "zip",
      sourcePath: "/tmp/catalog-chat",
      summary: { capabilities: { eveChat: true } },
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: chatProject.id,
      sourceRevisionId: deployedRevision.id,
      imageTag: "catalog-chat:stable",
      containerName: "catalog-chat-stable",
      internalPort: 3000,
      hostPort: 41981,
      runtimeKind: "docker",
    });
    await store.updateDeploymentStatus(deployment.id, "running");
    await store.ensureDeploymentRoutes(chatProject.id, deployment.id, "agent.localhost");
    await store.recordSourceRevision({
      projectId: chatProject.id,
      kind: "zip",
      sourcePath: "/tmp/catalog-chat-next",
      summary: { capabilities: { eveChat: false } },
      envVars: [],
      files: [],
      schedules: [],
    });

    const noChannelProject = await store.createProject({
      name: "No Channel",
      importKind: "zip",
    });
    const noChannelRevision = await store.recordSourceRevision({
      projectId: noChannelProject.id,
      kind: "zip",
      sourcePath: "/tmp/no-channel",
      summary: { capabilities: { eveChat: false } },
      envVars: [],
      files: [],
      schedules: [],
    });
    const noChannelDeployment = await store.recordDeployment({
      projectId: noChannelProject.id,
      sourceRevisionId: noChannelRevision.id,
      imageTag: "no-channel:stable",
      containerName: "no-channel-stable",
      internalPort: 3000,
      hostPort: 41982,
      runtimeKind: "docker",
    });
    await store.updateDeploymentStatus(noChannelDeployment.id, "running");
    await store.ensureDeploymentRoutes(
      noChannelProject.id,
      noChannelDeployment.id,
      "agent.localhost",
    );

    const stoppedProject = await store.createProject({
      name: "Stopped Chat",
      importKind: "zip",
    });
    const stoppedRevision = await store.recordSourceRevision({
      projectId: stoppedProject.id,
      kind: "zip",
      sourcePath: "/tmp/stopped-chat",
      summary: { capabilities: { eveChat: true } },
      envVars: [],
      files: [],
      schedules: [],
    });
    const stoppedDeployment = await store.recordDeployment({
      projectId: stoppedProject.id,
      sourceRevisionId: stoppedRevision.id,
      imageTag: "stopped-chat:stable",
      containerName: "stopped-chat-stable",
      internalPort: 3000,
      hostPort: 41983,
      runtimeKind: "docker",
    });
    await store.updateDeploymentStatus(stoppedDeployment.id, "stopped");
    await store.ensureDeploymentRoutes(stoppedProject.id, stoppedDeployment.id, "agent.localhost");

    const undeployedProject = await store.createProject({
      name: "Undeployed Chat",
      importKind: "zip",
    });
    await store.recordSourceRevision({
      projectId: undeployedProject.id,
      kind: "zip",
      sourcePath: "/tmp/undeployed-chat",
      summary: { capabilities: { eveChat: true } },
      envVars: [],
      files: [],
      schedules: [],
    });

    const response = await app.request("/agent-catalog", {
      headers: { origin: chatOrigin },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe(chatOrigin);
    await expect(response.json()).resolves.toEqual({
      agents: [
        {
          projectId: chatProject.id,
          name: "Catalog Chat",
          description: "Answers catalog questions.",
          url: `http://${chatProject.slug}.agent.localhost:4080`,
          capabilities: { eveChat: true },
        },
        {
          projectId: stoppedProject.id,
          name: stoppedProject.name,
          description: null,
          url: `http://${stoppedProject.slug}.agent.localhost:4080`,
          capabilities: { eveChat: true },
        },
      ],
    });
  });

  test("issues an app-scoped identity token for a registered return target", async () => {
    const { app, store } = await createIdentityApp();
    const connection = await store.createIdentityProviderConnection({
      type: "internal",
      displayName: "Internal",
      internalRealmKey: "members",
      enabled: true,
    });
    const realm = await store.createIdentityRealm({
      providerConnectionId: connection.id,
      externalRealmId: "members",
      externalRealmKind: "internal",
      displayName: "Members",
      enabled: true,
    });
    const controlCookie = await signIn(app);
    const login = await app.request("/identity/login?target=eve-chats&returnPath=%2F", {
      headers: { cookie: controlCookie },
      redirect: "manual",
    });
    const identityCookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";

    const response = await app.request("/identity/app-tokens", {
      method: "POST",
      headers: {
        cookie: identityCookie,
        origin: chatOrigin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ target: "eve-chats" }),
    });
    const body = (await response.json()) as {
      token: string;
      expiresAt: string;
    };
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.expiresAt).toEqual(expect.any(String));
    const payload = JSON.parse(
      Buffer.from(body.token.split(".")[1]!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;

    expect(payload).toMatchObject({
      iss: apiOrigin,
      aud: "eveland:app:eve-chats",
      principal_type: "user",
      realm_id: realm.id,
    });
    expect(payload).not.toHaveProperty("project_id");
  });
});

describe("Open access Identity Provider", () => {
  test("declines an identity login instead of pretending one is available", async () => {
    const { app } = await createIdentityApp({ keepOpenAccess: true });

    const response = await app.request(
      "/identity/login?target=eve-chats&returnPath=%2Fagents%2Fagent_1",
    );

    // Open access never redirects a caller into a login: non-browser callers
    // cannot follow one, and the old wording claimed the Provider was merely
    // "not available in this release", which is not what is happening.
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "identity_login_not_required" });
  });

  test("refuses to enable a second Provider while open access is on", async () => {
    const { app } = await createIdentityApp({ keepOpenAccess: true });
    const cookie = await signIn(app);

    const response = await app.request("/system/identity/providers", {
      method: "POST",
      headers: { cookie, origin: webOrigin, "content-type": "application/json" },
      body: JSON.stringify({
        type: "internal",
        displayName: "Eveland Internal",
        internalRealmKey: "eveland-members",
        enabled: true,
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("Only one Identity Provider"),
    });
  });

  test("accepts a disabled Provider so a switch can be staged before it takes effect", async () => {
    const { app, store } = await createIdentityApp({ keepOpenAccess: true });
    const cookie = await signIn(app);

    const created = await app.request("/system/identity/providers", {
      method: "POST",
      headers: { cookie, origin: webOrigin, "content-type": "application/json" },
      body: JSON.stringify({
        type: "internal",
        displayName: "Eveland Internal",
        internalRealmKey: "eveland-members",
        enabled: false,
      }),
    });
    expect(created.status).toBe(201);
    const { provider } = (await created.json()) as {
      provider: { id: string; securityRevision: number };
    };

    await disableSeededOpenIdentityProvider(store);
    const enabled = await app.request(`/system/identity/providers/${provider.id}`, {
      method: "PATCH",
      headers: { cookie, origin: webOrigin, "content-type": "application/json" },
      body: JSON.stringify({
        expectedSecurityRevision: provider.securityRevision,
        displayName: "Eveland Internal",
        enabled: true,
      }),
    });

    expect(enabled.status).toBe(200);
    const active = (await store.listIdentityProviderConnections()).filter(
      (candidate) => candidate.enabled,
    );
    expect(active).toEqual([expect.objectContaining({ id: provider.id, type: "internal" })]);
  });
});

describe("Internal open-access Caller Token minting", () => {
  test("mints for the Gateway's service token and stays invisible without it", async () => {
    const { app, store } = await createIdentityApp({ keepOpenAccess: true });
    const project = await store.createProject({ name: "gateway-mint", importKind: "zip" });

    const unauthenticated = await app.request("/internal/identity/open-caller-tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id }),
    });
    expect(unauthenticated.status).toBe(404);

    const response = await app.request("/internal/identity/open-caller-tokens", {
      method: "POST",
      headers: {
        authorization: "Bearer gateway-service-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ projectId: project.id }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { token: string; expiresAt: string };
    const claims = JSON.parse(
      Buffer.from(body.token.split(".")[1]!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(claims).toMatchObject({
      aud: `eveland:project:${project.id}`,
      principal_type: "user",
      sub: expect.stringMatching(/^iprn_/),
    });
  });

  test("reports open access being switched off as 409, not as an outage", async () => {
    const { app, store } = await createIdentityApp();
    const project = await store.createProject({ name: "internal-mode", importKind: "zip" });
    await store.createIdentityProviderConnection({
      type: "internal",
      displayName: "Eveland Internal",
      internalRealmKey: "members",
      enabled: true,
    });

    const response = await app.request("/internal/identity/open-caller-tokens", {
      method: "POST",
      headers: {
        authorization: "Bearer gateway-service-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ projectId: project.id }),
    });

    // The Gateway distinguishes the two: 409 means stop injecting and stop
    // asking, anything else means retry shortly.
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "identity_open_access_inactive" });
  });
});
