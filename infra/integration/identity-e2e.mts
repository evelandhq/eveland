// End-to-end proof of the eve 0.30 / Identity Provider handoff (#269 + #271):
// a REAL imported Agent whose eve channel authenticates with the workspace
// SDK's evelandIdentity() -- and nothing else -- deployed through the real
// build_deploy pipeline and driven through the real Gateway against the real
// control-plane API.
//
// Open access (the fresh-install default seeded by migration 0048):
//   - a public request carrying no Authorization gets a Caller Token injected
//     by the Gateway, which the Agent verifies against the platform JWKS and
//     admits: the turn is accepted and streams to turn.completed;
//   - a caller-supplied bad token is forwarded untouched and the Agent 401s
//     ("a bad token is worse than none", docs/zh/reference/design/identity.md);
//   - the Agent itself is the enforcement point: bypassing the Gateway and
//     hitting the deployment port without a token 401s with the eveland
//     Bearer challenge.
//
// Eveland Internal (switched exactly as an administrator would, over the
// /system HTTP API with a real Better Auth admin session):
//   - a cold Gateway stops injecting (the mint route answers 409), so an
//     anonymous request reaches the Agent bare and 401s with a challenge the
//     SDK's own parseEvelandAuthenticationChallenge understands;
//   - the real login handoff (/identity/login -> Better Auth session ->
//     eveland_identity cookie -> /identity/caller-tokens) mints a Caller
//     Token that authenticates a turn end to end;
//   - a Caller Token minted for a different Project is rejected by the Agent
//     (audience binding), and the warm pre-switch Gateway keeps injecting its
//     cached open-access token until that token's TTL runs out -- pinned here
//     deliberately because it is an operator-visible consequence of the
//     switch, not something this harness can wish away.
//
// OIDC (switched over the same /system API):
//   - a REAL loopback OpenID Provider (discovery document, RS256 JWKS, token
//     endpoint with client_secret_basic + PKCE S256 verification) stands in
//     for 金数据/Auth0, and EVELAND_IDENTITY_OIDC_ALLOW_INSECURE=1 lets the
//     production openid-client protocol talk to it over http;
//   - the admin preflight passes against the live discovery document;
//   - the whole redirect chain runs without a browser: /identity/login 302s
//     to the IdP, the "IdP" authorizes, GET /identity/oidc/callback exchanges
//     the code (PKCE verified server-side), sets the eveland_identity cookie,
//     and the session mints a Caller Token that authenticates a full turn;
//   - a login resolving to an unregistered Realm is refused 403, and a
//     replayed callback dies 400 on the one-shot transaction.
//
// Run locally (Docker runtime):
//   EVELAND_AGENT_BASE_DOMAINS=agent.localhost pnpm exec tsx infra/integration/identity-e2e.mts
// or inside the Lima VM with EVELAND_RUNTIME=systemd, like the other e2e's.
import assert from "node:assert/strict";
import { startWorkflowRuntime, type WorkflowRuntime } from "./workflow-runtime.mts";
import { execFile } from "node:child_process";
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import http, { type IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { serve } from "../../apps/gateway/node_modules/@hono/node-server/dist/index.mjs";
import { createApp } from "../../apps/api/src/app.js";
import { createControlPlaneAuthRuntime } from "../../apps/api/src/app.test-support.js";
import { createGatewayApp } from "../../apps/gateway/src/app.js";
import { createApiIdentityClient } from "../../apps/gateway/src/identity-client.js";
import { encryptSecretValue } from "../../packages/core/src/server/secrets.js";
import { GATEWAY_PORT, PUBLIC_ORIGIN_FALLBACK } from "../../packages/core/src/ports.js";
import { materializeEveFixtureDirectory } from "../../packages/core/src/server/eve-fixture.js";
import { createPgliteTestStore } from "../../packages/db/src/test-store.js";
import { parseEvelandAuthenticationChallenge } from "../../packages/sdk/src/auth.js";
import { processNextJob } from "../../apps/worker/src/jobs/process.js";
import { createRuntimeAdapterFromEnv } from "../../apps/worker/src/runtime/select.js";

const execFileAsync = promisify(execFile);

const APP_SECRET_KEY = process.env.APP_SECRET_KEY ?? "eveland-dev-secret-key-000000000";
const GATEWAY_SERVICE_TOKEN = "identity-e2e-gateway-service-token-000000";
const WEB_ORIGIN = PUBLIC_ORIGIN_FALLBACK;
const CHAT_ORIGIN = "http://localhost:3010";
const ADMIN = {
  email: "admin@example.com",
  name: "Identity E2E Admin",
  password: "admin-password",
};
const FIXTURE_TEMPLATE = fileURLToPath(
  new URL("../../apps/worker/src/integration/fixtures/identity-e2e", import.meta.url),
);
const SDK_DIR = fileURLToPath(new URL("../../packages/sdk", import.meta.url));

type HttpResult = {
  statusCode: number;
  headers: IncomingMessage["headers"];
  setCookies: string[];
  body: string;
};

async function main(): Promise<void> {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "eveland-identity-e2e-source-"));
  const priorNodeEnv = process.env.NODE_ENV;
  const priorAllowInsecure = process.env.EVELAND_IDENTITY_OIDC_ALLOW_INSECURE;
  process.env.NODE_ENV = "test";
  // The OIDC act runs the production openid-client protocol against a
  // loopback IdP; read at createApp() time, so it must be set before then.
  process.env.EVELAND_IDENTITY_OIDC_ALLOW_INSECURE = "1";
  process.env.EVELAND_HEALTH_TIMEOUT_MS ??= "60000";
  const servers: Array<ReturnType<typeof serve>> = [];
  const processNames: string[] = [];
  let runtime: ReturnType<typeof createRuntimeAdapterFromEnv> | null = null;
  const database = await createPgliteTestStore();
  // Turns execute only via the external dispatcher.
  const workflowRuntime: WorkflowRuntime = await startWorkflowRuntime(database.store);
  const { store } = database;
  try {
    const source = path.join(fixtureRoot, "source");
    await materializeEveFixtureDirectory(FIXTURE_TEMPLATE, source);
    // The fixture's `eveland` dependency is the WORKSPACE SDK, packed fresh so
    // the Agent runs the code under review rather than a published snapshot.
    // pnpm materializes the catalog peer range into plain semver on pack. The
    // tarball is unpacked into a `file:` DIRECTORY dependency because source
    // import records every small file as utf8 text -- a binary tarball in the
    // fixture would poison the source_files insert with NUL bytes.
    const packedSdk = path.join(fixtureRoot, "eveland-sdk.tgz");
    await execFileAsync("pnpm", ["-C", SDK_DIR, "pack", "--out", packedSdk]);
    const sdkDir = path.join(source, "eveland-sdk");
    await mkdir(sdkDir, { recursive: true });
    await execFileAsync("tar", ["-xzf", packedSdk, "-C", sdkDir, "--strip-components", "1"]);

    runtime = createRuntimeAdapterFromEnv();

    // --- Control-plane API over real HTTP (identity broker, JWKS, /system) ---
    let apiApp: ReturnType<typeof createApp> | null = null;
    const apiServer = serve({
      fetch: (request: Request) => apiApp!.fetch(request),
      port: 0,
    });
    servers.push(apiServer);
    if (!apiServer.listening) await once(apiServer, "listening");
    const apiAddress = apiServer.address();
    if (!apiAddress || typeof apiAddress === "string") throw new Error("API server did not bind.");
    const apiPort = apiAddress.port;
    const issuer = `http://127.0.0.1:${apiPort}`;
    // The deployed Agent fetches the JWKS from inside its runtime: the Docker
    // runtime reaches the host as host.docker.internal (the adapter passes
    // --add-host host.docker.internal:host-gateway), systemd shares localhost.
    const jwksUrl =
      runtime.name === "docker"
        ? `http://host.docker.internal:${apiPort}/.well-known/jwks.json`
        : `${issuer}/.well-known/jwks.json`;

    const auth = createControlPlaneAuthRuntime({
      db: database.db,
      baseURL: issuer,
      webOrigin: WEB_ORIGIN,
      secret: "test-secret-with-at-least-thirty-two-characters",
    });
    await auth.bootstrapDefaultAdmin(ADMIN);
    await store.upsertIdentityReturnTarget({
      key: "eve-chats",
      origin: CHAT_ORIGIN,
      enabled: true,
    });
    apiApp = createApp(store, {
      auth,
      webOrigin: WEB_ORIGIN,
      appSecretKey: APP_SECRET_KEY,
      identityIssuer: issuer,
      identityAllowedOrigins: [CHAT_ORIGIN],
      gatewayServiceToken: GATEWAY_SERVICE_TOKEN,
    });

    // Fresh install state: migration 0048 seeded open access as the enabled
    // platform Identity Provider. Everything in the open phase depends on it.
    const seeded = (await store.listIdentityProviderConnections()).find(
      (provider) => provider.enabled,
    );
    assert.equal(seeded?.type, "open", "migration must seed open access as the enabled Provider");

    // --- Import + build + deploy the Agent through the real pipeline ---
    const project = await store.createProject({
      name: `Identity E2E ${Date.now()}`,
      importKind: "zip",
      sourcePath: source,
    });
    await store.upsertSecret(
      project.id,
      "EVE_MOCK_AUTHORED_MODELS",
      JSON.stringify(encryptSecretValue("1", APP_SECRET_KEY)),
    );
    const jobOptions = {
      appSecretKey: APP_SECRET_KEY,
      runtime,
      identityIssuer: issuer,
      identityJwksUrl: jwksUrl,
    };
    assert.equal(await processNextJob(store, "identity-e2e", jobOptions), true, "import job");
    assert.equal((await store.getProject(project.id))?.status, "imported", "fixture import failed");
    await store.enqueueJob(project.id, "build_deploy");
    assert.equal(await processNextJob(store, "identity-e2e", jobOptions), true, "build_deploy job");
    const deployment = await store.getCurrentDeployment(project.id);
    if (!deployment) {
      const logs = await store.listLogs(project.id);
      console.error(logs.map((log) => `[${log.type}] ${log.line}`).join("\n"));
    }
    assert.ok(deployment, "no current deployment after build_deploy");
    assert.equal(deployment.status, "running", "deployment is not running");
    processNames.push(deployment.containerName);

    // --- Gateway #1: the long-lived process that serves the open phase ---
    const warmGateway = await startGateway(store, apiPort, servers);
    const agentHost = `${project.slug}.agent.localhost:${GATEWAY_PORT}`;

    // ============================ OPEN ACCESS ============================
    // Anonymous public request: the Gateway mints a Caller Token from the real
    // API mint route and injects it; the Agent's evelandIdentity() fetches the
    // platform JWKS and verifies. auth: [evelandIdentity()] has no fallback,
    // so 202 here proves the injected token authenticated.
    const openCreate = await request(warmGateway.port, {
      host: agentHost,
      path: "/eve/v1/session",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Say hello to the open-access caller." }),
    });
    assert.equal(
      openCreate.statusCode,
      202,
      `open-access session create failed: ${openCreate.body}`,
    );
    const openSessionId =
      openCreate.headers["x-eve-session-id"]?.toString() ??
      (JSON.parse(openCreate.body) as { sessionId?: string }).sessionId;
    assert.ok(openSessionId, "open-access session id missing");

    // The injected identity carries a full model turn, not just admission.
    const openStream = await streamUntilTurnCompleted(warmGateway.port, agentHost, openSessionId);
    assert.ok(openStream.completedMs > 0, "open-access turn did not complete");

    // A caller-supplied credential is forwarded untouched -- the Gateway must
    // not paper over a bad token with a minted one ("a bad token is worse
    // than none", docs/zh/reference/design/identity.md).
    const badToken = await request(warmGateway.port, {
      host: agentHost,
      path: "/eve/v1/session",
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer this-is-not-a-caller-token",
      },
      body: JSON.stringify({ message: "This must not authenticate." }),
    });
    assert.equal(badToken.statusCode, 401, `bad token must 401: ${badToken.statusCode}`);

    // The Agent, not the Gateway, is the enforcement point: bypass the Gateway
    // entirely and the deployment still refuses anonymous callers, answering
    // with the eveland Bearer challenge evelandIdentity() declares.
    const direct = await request(deployment.hostPort, {
      host: `127.0.0.1:${deployment.hostPort}`,
      path: "/eve/v1/session",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "No token, no entry." }),
    });
    assert.equal(direct.statusCode, 401, `direct anonymous request must 401: ${direct.body}`);
    const directChallenge = parseEvelandAuthenticationChallenge(
      direct.headers["www-authenticate"]?.toString() ?? null,
    );
    assert.ok(
      directChallenge,
      `Agent must advertise the eveland challenge: ${direct.headers["www-authenticate"]}`,
    );
    assert.equal(directChallenge.projectId, project.id);
    assert.equal(directChallenge.url, `${issuer}/identity/login`);

    console.log("identity-e2e: open access phase OK");

    // ==================== SWITCH TO EVELAND INTERNAL =====================
    // Driven through the real /system HTTP API with a real admin session,
    // exactly as the Settings UI would.
    const adminCookie = await signInAdmin(apiPort);
    const providers = (await apiRequest(apiPort, adminCookie, "GET", "/system/identity/providers"))
      .json as {
      providers: Array<{
        id: string;
        type: string;
        enabled: boolean;
        securityRevision: number;
        displayName: string;
      }>;
    };
    const openProvider = providers.providers.find((provider) => provider.enabled);
    assert.ok(openProvider && openProvider.type === "open");
    const disabled = await apiRequest(
      apiPort,
      adminCookie,
      "PATCH",
      `/system/identity/providers/${openProvider.id}`,
      {
        expectedSecurityRevision: openProvider.securityRevision,
        displayName: openProvider.displayName,
        enabled: false,
      },
    );
    assert.equal(disabled.statusCode, 200, `disabling open access failed: ${disabled.body}`);
    const createdInternal = await apiRequest(
      apiPort,
      adminCookie,
      "POST",
      "/system/identity/providers",
      {
        type: "internal",
        displayName: "Eveland Internal",
        internalRealmKey: "members",
        enabled: true,
      },
    );
    assert.equal(
      createdInternal.statusCode,
      201,
      `creating internal Provider failed: ${createdInternal.body}`,
    );
    const internalProviderId = (createdInternal.json as { provider: { id: string } }).provider.id;
    const createdRealm = await apiRequest(apiPort, adminCookie, "POST", "/system/identity/realms", {
      providerConnectionId: internalProviderId,
      externalRealmId: "members",
      externalRealmKind: "internal",
      displayName: "Members",
      enabled: true,
    });
    assert.equal(
      createdRealm.statusCode,
      201,
      `creating internal Realm failed: ${createdRealm.body}`,
    );

    // Operator-visible switch lag, pinned deliberately: the warm Gateway holds
    // the open-access Caller Token it minted before the switch and keeps
    // injecting it until the token's own TTL (20 minutes by default) runs
    // out. Anonymous callers therefore KEEP GETTING IN through an already-warm
    // Gateway after an administrator has switched the platform to Eveland
    // Internal. If this assertion ever starts failing with a 401, the platform
    // grew a way to revoke or invalidate that cache on switch -- delete this
    // block and the finding it documents.
    const staleInjection = await request(warmGateway.port, {
      host: agentHost,
      path: "/eve/v1/session",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Cached open token still admits me." }),
    });
    assert.equal(
      staleInjection.statusCode,
      202,
      `expected the warm Gateway to keep injecting its cached open-access token: ${staleInjection.statusCode} ${staleInjection.body}`,
    );

    // ======================= EVELAND INTERNAL ============================
    // A cold Gateway (fresh process, empty token cache -- what any Gateway
    // becomes after a restart) asks the mint route, gets 409, and injects
    // nothing: the anonymous request reaches the Agent bare and is refused
    // with the challenge the SDK's own client-side parser understands.
    const coldGateway = await startGateway(store, apiPort, servers);
    const anonymousInternal = await request(coldGateway.port, {
      host: agentHost,
      path: "/eve/v1/session",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Anonymous must be refused now." }),
    });
    assert.equal(
      anonymousInternal.statusCode,
      401,
      `internal mode must refuse anonymous callers: ${anonymousInternal.statusCode} ${anonymousInternal.body}`,
    );
    const challenge = parseEvelandAuthenticationChallenge(
      anonymousInternal.headers["www-authenticate"]?.toString() ?? null,
    );
    assert.ok(challenge, `challenge missing: ${anonymousInternal.headers["www-authenticate"]}`);
    assert.equal(challenge.projectId, project.id);
    assert.equal(challenge.url, `${issuer}/identity/login`);

    // The real login handoff: /identity/login sees the admin's control-plane
    // session, finalizes an Identity Session, and sets the eveland_identity
    // cookie on the redirect back to the return target.
    const login = await request(apiPort, {
      host: `127.0.0.1:${apiPort}`,
      path: "/identity/login?target=eve-chats&returnPath=%2Fagents%2Fidentity-e2e",
      method: "GET",
      headers: { cookie: adminCookie },
    });
    assert.equal(
      login.statusCode,
      302,
      `identity login must redirect: ${login.statusCode} ${login.body}`,
    );
    assert.equal(login.headers.location, `${CHAT_ORIGIN}/agents/identity-e2e`);
    const identityCookie = login.setCookies
      .map((cookie) => cookie.split(";", 1)[0]!)
      .find((cookie) => cookie.startsWith("eveland_identity="));
    assert.ok(identityCookie, `eveland_identity cookie missing: ${login.setCookies.join(" | ")}`);

    // Browser-shaped Caller Token mint: identity session cookie + allowed
    // web-chat origin.
    const minted = await request(apiPort, {
      host: `127.0.0.1:${apiPort}`,
      path: "/identity/caller-tokens",
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: CHAT_ORIGIN,
        cookie: identityCookie,
      },
      body: JSON.stringify({ projectId: project.id }),
    });
    assert.equal(minted.statusCode, 200, `caller token mint failed: ${minted.body}`);
    const callerToken = (JSON.parse(minted.body) as { token?: string }).token;
    assert.ok(callerToken, "caller token missing from mint response");

    // The minted internal-mode token authenticates a full turn end to end.
    const internalCreate = await request(coldGateway.port, {
      host: agentHost,
      path: "/eve/v1/session",
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${callerToken}`,
      },
      body: JSON.stringify({ message: "Say hello to the signed-in caller." }),
    });
    assert.equal(
      internalCreate.statusCode,
      202,
      `internal session create failed: ${internalCreate.body}`,
    );
    const internalSessionId =
      internalCreate.headers["x-eve-session-id"]?.toString() ??
      (JSON.parse(internalCreate.body) as { sessionId?: string }).sessionId;
    assert.ok(internalSessionId, "internal session id missing");
    const internalStream = await streamUntilTurnCompleted(
      coldGateway.port,
      agentHost,
      internalSessionId,
      `Bearer ${callerToken}`,
    );
    assert.ok(internalStream.completedMs > 0, "internal turn did not complete");

    // Audience binding: a Caller Token minted for a DIFFERENT Project is
    // signed by the same platform key but must be refused by this Agent.
    const otherProject = await store.createProject({
      name: `Identity E2E Other ${Date.now()}`,
      importKind: "zip",
    });
    const foreignMint = await request(apiPort, {
      host: `127.0.0.1:${apiPort}`,
      path: "/identity/caller-tokens",
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: CHAT_ORIGIN,
        cookie: identityCookie,
      },
      body: JSON.stringify({ projectId: otherProject.id }),
    });
    assert.equal(foreignMint.statusCode, 200, `foreign mint failed: ${foreignMint.body}`);
    const foreignToken = (JSON.parse(foreignMint.body) as { token?: string }).token;
    assert.ok(foreignToken);
    const crossProject = await request(coldGateway.port, {
      host: agentHost,
      path: "/eve/v1/session",
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${foreignToken}`,
      },
      body: JSON.stringify({ message: "Wrong audience must be refused." }),
    });
    assert.equal(
      crossProject.statusCode,
      401,
      `a Caller Token for another Project must 401: ${crossProject.statusCode}`,
    );

    console.log("identity-e2e: eveland internal phase OK");

    // ========================= SWITCH TO OIDC ============================
    // A real loopback OpenID Provider; the platform talks to it through the
    // production openid-client protocol (discovery, JWKS, PKCE, basic auth).
    const idp = await startFakeIdp(servers);
    const internalProviders = (
      await apiRequest(apiPort, adminCookie, "GET", "/system/identity/providers")
    ).json as {
      providers: Array<{
        id: string;
        type: string;
        enabled: boolean;
        securityRevision: number;
        displayName: string;
      }>;
    };
    const activeInternal = internalProviders.providers.find((provider) => provider.enabled);
    assert.ok(activeInternal && activeInternal.type === "internal");
    const internalOff = await apiRequest(
      apiPort,
      adminCookie,
      "PATCH",
      `/system/identity/providers/${activeInternal.id}`,
      {
        expectedSecurityRevision: activeInternal.securityRevision,
        displayName: activeInternal.displayName,
        enabled: false,
      },
    );
    assert.equal(internalOff.statusCode, 200, `disabling internal failed: ${internalOff.body}`);
    const createdOidc = await apiRequest(
      apiPort,
      adminCookie,
      "POST",
      "/system/identity/providers",
      {
        type: "oidc",
        displayName: "Identity E2E IdP",
        issuer: idp.issuer,
        clientId: idp.clientId,
        clientSecret: idp.clientSecret,
        scopes: ["openid", "profile", "email"],
        tokenEndpointAuthMethod: "client_secret_basic",
        externalRealmResolution: "id_token_claim",
        externalRealmClaim: "account_id",
        enabled: true,
      },
    );
    assert.equal(createdOidc.statusCode, 201, `creating OIDC Provider failed: ${createdOidc.body}`);
    const oidcProviderId = (createdOidc.json as { provider: { id: string } }).provider.id;
    const oidcRealm = await apiRequest(apiPort, adminCookie, "POST", "/system/identity/realms", {
      providerConnectionId: oidcProviderId,
      externalRealmId: "acct_42",
      externalRealmKind: "account",
      displayName: "E2E Account",
      enabled: true,
    });
    assert.equal(oidcRealm.statusCode, 201, `creating OIDC Realm failed: ${oidcRealm.body}`);

    // The admin preflight runs live discovery against the IdP.
    const preflight = await apiRequest(
      apiPort,
      adminCookie,
      "POST",
      `/system/identity/providers/${oidcProviderId}/preflight`,
    );
    assert.equal(preflight.statusCode, 200, `preflight failed: ${preflight.body}`);
    assert.equal(
      (preflight.json as { ok: boolean }).ok,
      true,
      `preflight must pass against the live IdP: ${preflight.body}`,
    );

    // The whole login chain, browser-free: login 302 -> IdP authorizes ->
    // callback exchanges the code (PKCE verified by the IdP) -> cookie.
    const oidcLogin = await request(apiPort, {
      host: `127.0.0.1:${apiPort}`,
      path: "/identity/login?target=eve-chats&returnPath=%2Fagents%2Fidentity-e2e",
      method: "GET",
      headers: {},
    });
    assert.equal(oidcLogin.statusCode, 302, `OIDC login must redirect: ${oidcLogin.body}`);
    const authorizationUrl = new URL(oidcLogin.headers.location?.toString() ?? "");
    assert.ok(
      authorizationUrl.href.startsWith(`${idp.issuer}/authorize`),
      `login must redirect to the IdP: ${authorizationUrl.href}`,
    );
    const callbackUrl = idp.authorize(authorizationUrl);
    const callback = await request(apiPort, {
      host: `127.0.0.1:${apiPort}`,
      path: `${callbackUrl.pathname}${callbackUrl.search}`,
      method: "GET",
      headers: {},
    });
    assert.equal(
      callback.statusCode,
      302,
      `OIDC callback must complete the login: ${callback.statusCode} ${callback.body}`,
    );
    assert.equal(callback.headers.location, `${CHAT_ORIGIN}/agents/identity-e2e`);
    const oidcCookie = callback.setCookies
      .map((cookie) => cookie.split(";", 1)[0]!)
      .find((cookie) => cookie.startsWith("eveland_identity="));
    assert.ok(oidcCookie, `eveland_identity cookie missing: ${callback.setCookies.join(" | ")}`);

    // A replayed callback dies on the one-shot transaction.
    const replay = await request(apiPort, {
      host: `127.0.0.1:${apiPort}`,
      path: `${callbackUrl.pathname}${callbackUrl.search}`,
      method: "GET",
      headers: {},
    });
    assert.equal(replay.statusCode, 400, `replayed callback must 400: ${replay.statusCode}`);

    // The OIDC-established session mints a Caller Token that carries a full
    // turn through the same Gateway and Agent as the other providers.
    const oidcMint = await request(apiPort, {
      host: `127.0.0.1:${apiPort}`,
      path: "/identity/caller-tokens",
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: CHAT_ORIGIN,
        cookie: oidcCookie,
      },
      body: JSON.stringify({ projectId: project.id }),
    });
    assert.equal(oidcMint.statusCode, 200, `OIDC caller token mint failed: ${oidcMint.body}`);
    const oidcToken = (JSON.parse(oidcMint.body) as { token?: string }).token;
    assert.ok(oidcToken, "OIDC caller token missing");
    const oidcCreate = await request(coldGateway.port, {
      host: agentHost,
      path: "/eve/v1/session",
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${oidcToken}`,
      },
      body: JSON.stringify({ message: "Say hello to the OIDC caller." }),
    });
    assert.equal(oidcCreate.statusCode, 202, `OIDC session create failed: ${oidcCreate.body}`);
    const oidcSessionId =
      oidcCreate.headers["x-eve-session-id"]?.toString() ??
      (JSON.parse(oidcCreate.body) as { sessionId?: string }).sessionId;
    assert.ok(oidcSessionId, "OIDC session id missing");
    const oidcStream = await streamUntilTurnCompleted(
      coldGateway.port,
      agentHost,
      oidcSessionId,
      `Bearer ${oidcToken}`,
    );
    assert.ok(oidcStream.completedMs > 0, "OIDC turn did not complete");

    // A login whose Realm claim is not on the allowlist is refused.
    idp.claims = { ...idp.claims, account_id: "acct_unknown" };
    const strangerLogin = await request(apiPort, {
      host: `127.0.0.1:${apiPort}`,
      path: "/identity/login?target=eve-chats&returnPath=%2Fagents%2Fidentity-e2e",
      method: "GET",
      headers: {},
    });
    assert.equal(strangerLogin.statusCode, 302);
    const strangerCallback = idp.authorize(
      new URL(strangerLogin.headers.location?.toString() ?? ""),
    );
    const strangerResult = await request(apiPort, {
      host: `127.0.0.1:${apiPort}`,
      path: `${strangerCallback.pathname}${strangerCallback.search}`,
      method: "GET",
      headers: {},
    });
    assert.equal(
      strangerResult.statusCode,
      403,
      `unregistered Realm must 403: ${strangerResult.statusCode} ${strangerResult.body}`,
    );

    console.log(
      `IDENTITY E2E OK runtime=${runtime.name} open=202 badToken=401 direct=401 ` +
        `staleWarmGatewayInjection=202 internalAnonymous=401 internalToken=202 crossProject=401 ` +
        `oidcPreflight=ok oidcToken=202 oidcReplay=400 oidcStrangerRealm=403 ` +
        `openTurnMs=${openStream.completedMs} internalTurnMs=${internalStream.completedMs} ` +
        `oidcTurnMs=${oidcStream.completedMs}`,
    );
  } finally {
    process.env.NODE_ENV = priorNodeEnv;
    if (priorAllowInsecure === undefined) {
      delete process.env.EVELAND_IDENTITY_OIDC_ALLOW_INSECURE;
    } else {
      process.env.EVELAND_IDENTITY_OIDC_ALLOW_INSECURE = priorAllowInsecure;
    }
    for (const server of servers) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (runtime) {
      await Promise.all(
        processNames.map((name) => runtime!.stopProcess(name).catch(() => undefined)),
      );
    }
    await workflowRuntime.stop().catch(() => {});
    await database.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

type FakeIdp = {
  port: number;
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Claims stamped into the next ID token; mutate to shape the next login. */
  claims: Record<string, unknown>;
  /**
   * Plays the IdP's half of the authorization redirect: validates the
   * request a browser would carry, records the PKCE challenge and nonce
   * against a fresh code, and returns the callback URL the browser would be
   * sent back to.
   */
  authorize(authorizationUrl: URL): URL;
};

/**
 * A real loopback OpenID Provider over HTTP: live discovery document, RS256
 * JWKS, and a token endpoint that enforces client_secret_basic and PKCE
 * S256. Real enough that the production openid-client protocol completes
 * discovery, code exchange, and ID token verification against it.
 */
async function startFakeIdp(servers: Array<ReturnType<typeof serve>>): Promise<FakeIdp> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyId = "identity-e2e-idp-key";
  const clientId = "eveland-identity-e2e";
  const clientSecret = "identity-e2e-idp-client-secret";
  const codes = new Map<string, { nonce: string; codeChallenge: string; redirectUri: string }>();
  let issuer = "";
  const idp: FakeIdp = {
    port: 0,
    issuer: "",
    clientId,
    clientSecret,
    claims: {
      sub: "user_9527",
      name: "Identity E2E User",
      email: "user@example.com",
      account_id: "acct_42",
      account_role: "admin",
    },
    authorize(authorizationUrl) {
      assert.equal(authorizationUrl.searchParams.get("client_id"), clientId);
      assert.equal(authorizationUrl.searchParams.get("response_type"), "code");
      assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
      const state = authorizationUrl.searchParams.get("state");
      const nonce = authorizationUrl.searchParams.get("nonce");
      const codeChallenge = authorizationUrl.searchParams.get("code_challenge");
      const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
      assert.ok(state && nonce && codeChallenge && redirectUri, "authorization request incomplete");
      const code = randomBytes(16).toString("base64url");
      codes.set(code, { nonce, codeChallenge, redirectUri });
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", state);
      return callback;
    },
  };
  const server = serve({
    port: 0,
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/openid-configuration") {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          userinfo_endpoint: `${issuer}/userinfo`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
          code_challenge_methods_supported: ["S256"],
          id_token_signing_alg_values_supported: ["RS256"],
          subject_types_supported: ["public"],
          scopes_supported: ["openid", "profile", "email"],
          claims_supported: ["iss", "sub", "aud", "name", "email", "account_id", "account_role"],
        });
      }
      if (url.pathname === "/jwks") {
        return Response.json({
          keys: [{ ...publicKey.export({ format: "jwk" }), kid: keyId, alg: "RS256", use: "sig" }],
        });
      }
      if (url.pathname === "/token" && request.method === "POST") {
        const basic = request.headers.get("authorization") ?? "";
        const decoded = Buffer.from(basic.replace(/^Basic /, ""), "base64").toString("utf8");
        const [basicClient, basicSecret] = decoded.split(":", 2).map(decodeURIComponent);
        if (basicClient !== clientId || basicSecret !== clientSecret) {
          return Response.json({ error: "invalid_client" }, { status: 401 });
        }
        const form = new URLSearchParams(await request.text());
        const grant = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        if (form.get("grant_type") !== "authorization_code" || !grant) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        const verifier = form.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (challenge !== grant.codeChallenge || form.get("redirect_uri") !== grant.redirectUri) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        const issuedAt = Math.floor(Date.now() / 1000);
        const idToken = signRs256Jwt(
          {
            iss: issuer,
            aud: clientId,
            exp: issuedAt + 300,
            iat: issuedAt,
            nonce: grant.nonce,
            ...idp.claims,
          },
          privateKey,
          keyId,
        );
        return Response.json({
          access_token: randomBytes(24).toString("base64url"),
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid profile email",
          id_token: idToken,
        });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  servers.push(server);
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("IdP server did not bind.");
  idp.port = address.port;
  issuer = `http://127.0.0.1:${address.port}`;
  idp.issuer = issuer;
  return idp;
}

function signRs256Jwt(
  payload: Record<string, unknown>,
  privateKey: import("node:crypto").KeyObject,
  keyId: string,
): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode({ alg: "RS256", typ: "JWT", kid: keyId })}.${encode(payload)}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
}

async function startGateway(
  store: Awaited<ReturnType<typeof createPgliteTestStore>>["store"],
  apiPort: number,
  servers: Array<ReturnType<typeof serve>>,
): Promise<{ port: number }> {
  const app = createGatewayApp(store, {
    allowedBaseDomains: ["agent.localhost"],
    affinitySecret: "identity-e2e-affinity-secret",
    internalServiceToken: GATEWAY_SERVICE_TOKEN,
    routeCacheTtlMs: 1_000,
    identityClient: createApiIdentityClient({
      apiUrl: `http://127.0.0.1:${apiPort}`,
      serviceToken: GATEWAY_SERVICE_TOKEN,
    }),
  });
  const server = serve({ fetch: app.fetch, port: 0 });
  servers.push(server);
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Gateway server did not bind.");
  return { port: address.port };
}

async function signInAdmin(apiPort: number): Promise<string> {
  const response = await request(apiPort, {
    host: `127.0.0.1:${apiPort}`,
    path: "/api/auth/sign-in/email",
    method: "POST",
    headers: { "content-type": "application/json", origin: WEB_ORIGIN },
    body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
  });
  assert.equal(response.statusCode, 200, `admin sign-in failed: ${response.body}`);
  const sessionCookie = response.setCookies.map((cookie) => cookie.split(";", 1)[0]!).join("; ");
  assert.ok(sessionCookie, "admin session cookie missing");
  return sessionCookie;
}

async function apiRequest(
  apiPort: number,
  cookie: string,
  method: string,
  requestPath: string,
  body?: unknown,
): Promise<HttpResult & { json: unknown }> {
  const result = await request(apiPort, {
    host: `127.0.0.1:${apiPort}`,
    path: requestPath,
    method,
    headers: {
      cookie,
      origin: WEB_ORIGIN,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json: unknown = null;
  try {
    json = JSON.parse(result.body);
  } catch {
    // leave json null; callers assert on statusCode first
  }
  return { ...result, json };
}

function request(
  port: number,
  input: {
    host: string;
    path: string;
    method: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: input.path,
        method: input.method,
        headers: { host: input.host, ...input.headers },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            setCookies: response.headers["set-cookie"] ?? [],
            body,
          }),
        );
      },
    );
    req.setTimeout(120_000, () =>
      req.destroy(new Error(`${input.method} ${input.path} timed out`)),
    );
    req.once("error", reject);
    req.end(input.body);
  });
}

function streamUntilTurnCompleted(
  port: number,
  host: string,
  sessionId: string,
  authorization?: string,
): Promise<{ completedMs: number }> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: `/eve/v1/session/${encodeURIComponent(sessionId)}/stream`,
        headers: { host, ...(authorization ? { authorization } : {}) },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`stream answered ${response.statusCode}`));
          return;
        }
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          raw += chunk;
          if (raw.includes('"type":"turn.completed"')) {
            response.destroy();
            resolve({ completedMs: Date.now() - startedAt });
          }
        });
        response.on("end", () => {
          if (!raw.includes('"type":"turn.completed"')) {
            reject(new Error(`stream ended before turn.completed: ${raw.slice(0, 2_000)}`));
          }
        });
      },
    );
    req.setTimeout(120_000, () => req.destroy(new Error("stream timed out")));
    req.once("error", reject);
    req.end();
  });
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
