import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, test } from "vitest";
import { createGatewayApp, type GatewayRepository, type ResolvedAgentRoute } from "./app.js";
import { affinityBucketForRoute } from "@eveland/core/routing";

const servers: Array<ReturnType<typeof createServer>> = [];
const gatewayServers: Array<ReturnType<typeof serve>> = [];
const affinitySecret = "test-affinity-secret-with-enough-entropy";

afterEach(async () => {
  await Promise.all([
    ...servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    ...gatewayServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  ]);
});

describe("Gateway", () => {
  test("fails closed on missing affinity signing material or invalid body limits", () => {
    expect(() => createGatewayApp(repository([]), { allowedBaseDomains: ["agent.localhost"], affinitySecret: "" })).toThrow(
      /affinity secret/i,
    );
    expect(() => createGatewayApp(repository([]), {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      maxRequestBodyBytes: -1,
    })).toThrow(/request body limit/i);
  });

  test("routes stable and immutable preview hosts to their selected deployment", async () => {
    const upstream = await startUpstream((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ path: request.url, host: request.headers.host }));
    });
    const stable = route({ hostname: "p-alpha.agent.localhost", hostPort: upstream.port });
    const preview = route({ id: "route_preview", hostname: "d-v1--p-alpha.agent.localhost", kind: "deployment", hostPort: upstream.port });
    const app = createGatewayApp(repository([stable, preview]), { allowedBaseDomains: ["agent.localhost"], affinitySecret });

    const stableResponse = await app.request("http://p-alpha.agent.localhost/eve/v1/health", { headers: { host: "p-alpha.agent.localhost:4080" } });
    const previewResponse = await app.request("http://d-v1--p-alpha.agent.localhost/custom", {
      headers: { host: "d-v1--p-alpha.agent.localhost:4080" },
    });

    expect(stableResponse.status).toBe(200);
    await expect(stableResponse.json()).resolves.toEqual({ path: "/eve/v1/health", host: "p-alpha.agent.localhost:4080" });
    await expect(previewResponse.json()).resolves.toEqual({ path: "/custom", host: "d-v1--p-alpha.agent.localhost:4080" });
  });

  test("hides unknown and disabled hosts, and reports routes without a running target", async () => {
    const disabled = route({ hostname: "p-disabled.agent.localhost", enabled: false });
    const stopped = route({ hostname: "p-stopped.agent.localhost", deploymentStatus: "stopped" });
    const app = createGatewayApp(repository([disabled, stopped]), { allowedBaseDomains: ["agent.localhost"], affinitySecret });

    expect((await app.request("http://unknown.invalid/", { headers: { host: "unknown.invalid" } })).status).toBe(404);
    expect((await app.request("http://p-missing.agent.localhost/", { headers: { host: "p-missing.agent.localhost" } })).status).toBe(404);
    expect((await app.request("http://p-disabled.agent.localhost/", { headers: { host: "p-disabled.agent.localhost" } })).status).toBe(404);
    expect((await app.request("http://p-stopped.agent.localhost/", { headers: { host: "p-stopped.agent.localhost" } })).status).toBe(503);
  });

  test("preserves Agent auth and cookies while rebuilding spoofable forwarding headers", async () => {
    const upstream = await startUpstream((request, response) => {
      response.setHeader("set-cookie", ["eve_session=abc; HttpOnly", "variant=v1; HttpOnly"]);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(request.headers));
    });
    const app = createGatewayApp(repository([route({ hostPort: upstream.port })]), { allowedBaseDomains: ["agent.localhost"], affinitySecret });

    const response = await app.request("http://p-alpha.agent.localhost/eve/v1/session", {
      method: "POST",
      headers: {
        host: "p-alpha.agent.localhost:4080",
        authorization: "Bearer end-user-token",
        cookie: "app_session=user",
        "content-type": "application/json",
        forwarded: "for=attacker;host=localhost",
        "x-forwarded-host": "localhost",
        "x-eveland-deployment-id": "attacker",
        "x-eveland-version-key": "api-affinity-key",
      },
      body: JSON.stringify({ message: "hello" }),
    });
    const headers = (await response.json()) as Record<string, string>;

    expect(headers.authorization).toBe("Bearer end-user-token");
    expect(headers.cookie).toBe("app_session=user");
    expect(headers.host).toBe("p-alpha.agent.localhost:4080");
    expect(headers["x-forwarded-host"]).toBe("p-alpha.agent.localhost:4080");
    expect(headers.forwarded).not.toContain("attacker");
    expect(headers["x-eveland-deployment-id"]).toBeUndefined();
    expect(headers["x-eveland-version-key"]).toBeUndefined();
    expect(response.headers.getSetCookie()).toEqual(["eve_session=abc; HttpOnly", "variant=v1; HttpOnly"]);
  });

  test("streams the first NDJSON chunk without waiting for the upstream session to finish", async () => {
    let markClosed!: () => void;
    const closed = new Promise<void>((resolve) => { markClosed = resolve; });
    const upstream = await startUpstream((_request, response) => {
      response.once("close", markClosed);
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write('{"type":"turn.started"}\n');
      setTimeout(() => response.end('{"type":"turn.completed"}\n'), 250);
    });
    const app = createGatewayApp(repository([route({ hostPort: upstream.port })]), { allowedBaseDomains: ["agent.localhost"], affinitySecret });
    const startedAt = Date.now();
    const response = await app.request("http://p-alpha.agent.localhost/eve/v1/session/eve_1/stream", {
      headers: { host: "p-alpha.agent.localhost:4080" },
    });
    const reader = response.body!.getReader();
    const first = await reader.read();

    expect(new TextDecoder().decode(first.value)).toContain("turn.started");
    expect(Date.now() - startedAt).toBeLessThan(200);
    await reader.cancel();
    await expect(Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("upstream stream stayed open")), 200))])).resolves.toBeUndefined();
  });

  test("passes through a custom channel method, query, headers, and body", async () => {
    const upstream = await startUpstream((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          method: request.method,
          path: request.url,
          contentType: request.headers["content-type"],
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      });
    });
    const app = createGatewayApp(repository([route({ hostPort: upstream.port })]), {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
    });

    const response = await app.request("http://p-alpha.agent.localhost/channels/slack/events?team=T1", {
      method: "POST",
      headers: { host: "p-alpha.agent.localhost", "content-type": "application/json" },
      body: JSON.stringify({ event: "message" }),
    });

    await expect(response.json()).resolves.toEqual({
      method: "POST",
      path: "/channels/slack/events?team=T1",
      contentType: "application/json",
      body: JSON.stringify({ event: "message" }),
    });
  });

  test("writes an initial SessionBinding and uses it for continuation and workflow paths", async () => {
    const upstream = await startUpstream((request, response) => {
      if (request.url === "/eve/v1/session" && request.method === "POST") {
        response.writeHead(202, { "content-type": "application/json", "x-eve-session-id": "eve_bound" });
        response.end(JSON.stringify({ sessionId: "eve_bound" }));
        return;
      }
      response.end(`proxied:${request.url}`);
    });
    const repo = repository([route({ hostPort: upstream.port })]);
    const app = createGatewayApp(repo, { allowedBaseDomains: ["agent.localhost"], affinitySecret });

    const create = await app.request("http://p-alpha.agent.localhost/eve/v1/session", {
      method: "POST",
      headers: { host: "p-alpha.agent.localhost:4080", "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    const continuation = await app.request("http://p-alpha.agent.localhost/eve/v1/session/eve_bound", {
      method: "POST",
      headers: { host: "p-alpha.agent.localhost:4080" },
    });
    const workflow = await app.request("http://p-alpha.agent.localhost/.well-known/workflow/v1/flow", {
      headers: { host: "p-alpha.agent.localhost:4080" },
    });

    expect(create.status).toBe(202);
    expect(repo.bindings).toEqual([expect.objectContaining({ eveSessionId: "eve_bound", routeId: "route_project", deploymentId: "dep_1" })]);
    await expect(continuation.text()).resolves.toBe("proxied:/eve/v1/session/eve_bound");
    await expect(workflow.text()).resolves.toBe("proxied:/.well-known/workflow/v1/flow");
  });

  test("keeps bindings pinned across 90/10 to 50/50 and weight-zero policy changes", async () => {
    let firstSequence = 0;
    const first = await startUpstream((_request, response) => {
      const sessionId = `eve_a_${++firstSequence}`;
      response.writeHead(202, { "content-type": "application/json", "x-eve-session-id": sessionId });
      response.end(JSON.stringify({ deployment: "a", sessionId }));
    });
    const second = await startUpstream((_request, response) => {
      response.writeHead(202, { "content-type": "application/json", "x-eve-session-id": "eve_weighted" });
      response.end(JSON.stringify({ deployment: "b", sessionId: "eve_weighted" }));
    });
    const weighted = route({
      targets: [
        { routeId: "route_project", deploymentId: "dep_a", weight: 9_000, variantName: "control", hostPort: first.port, status: "running" },
        { routeId: "route_project", deploymentId: "dep_b", weight: 1_000, variantName: "candidate", hostPort: second.port, status: "running" },
      ],
    });
    const repo = repository([weighted]);
    const app = createGatewayApp(repo, { allowedBaseDomains: ["agent.localhost"], affinitySecret, routeCacheTtlMs: 0 });
    const affinity = Array.from({ length: 10_000 }, (_, index) => `bucket-${index}`).find(
      (key) => affinityBucketForRoute(weighted.id, weighted.policyRevision, key) >= 9_000,
    )!;
    const initial = await app.request("http://p-alpha.agent.localhost/eve/v1/session", {
      method: "POST",
      headers: {
        host: "p-alpha.agent.localhost",
        "x-eveland-version-key": affinity,
        "content-type": "application/json",
      },
      body: "{}",
    });
    await expect(initial.json()).resolves.toMatchObject({ deployment: "b" });
    expect(repo.bindings).toContainEqual(expect.objectContaining({
      eveSessionId: "eve_weighted",
      deploymentId: "dep_b",
      experimentId: "route_project:r1",
    }));

    weighted.policyRevision = 2;
    weighted.targets = [
      { routeId: "route_project", deploymentId: "dep_a", weight: 5_000, variantName: "control", hostPort: first.port, status: "running" },
      { routeId: "route_project", deploymentId: "dep_b", weight: 5_000, variantName: "candidate", hostPort: second.port, status: "running" },
    ];
    const continuation = await app.request("http://p-alpha.agent.localhost/eve/v1/session/eve_weighted", {
      method: "POST", headers: { host: "p-alpha.agent.localhost", "x-eveland-version-key": affinity },
    });
    await expect(continuation.json()).resolves.toMatchObject({ deployment: "b" });

    weighted.policyRevision = 3;
    weighted.targets = [
      { routeId: "route_project", deploymentId: "dep_a", weight: 10_000, variantName: "control", hostPort: first.port, status: "running" },
      { routeId: "route_project", deploymentId: "dep_b", weight: 0, variantName: "candidate", hostPort: second.port, status: "running" },
    ];
    const afterZero = await app.request("http://p-alpha.agent.localhost/eve/v1/session", {
      method: "POST",
      headers: { host: "p-alpha.agent.localhost", "x-eveland-version-key": affinity, "content-type": "application/json" },
      body: "{}",
    });
    await expect(afterZero.json()).resolves.toMatchObject({ deployment: "a" });
    const pinnedAfterZero = await app.request("http://p-alpha.agent.localhost/eve/v1/session/eve_weighted", {
      method: "POST",
      headers: { host: "p-alpha.agent.localhost" },
    });
    await expect(pinnedAfterZero.json()).resolves.toMatchObject({ deployment: "b" });
    expect(repo.bindings).toContainEqual(expect.objectContaining({
      deploymentId: "dep_b",
      variantName: "candidate",
      experimentId: "route_project:r1",
      affinitySource: "version_key",
      affinityFingerprint: expect.stringMatching(/^sha256-[a-f0-9]{64}$/),
    }));
    expect(repo.bindings).toContainEqual(expect.objectContaining({
      eveSessionId: "eve_a_1",
      deploymentId: "dep_a",
      experimentId: "route_project:r3",
    }));
  });

  test("issues and verifies a signed HttpOnly affinity cookie without storing the raw key", async () => {
    let sequence = 0;
    const selected: string[] = [];
    const makeUpstream = async (deployment: string) => startUpstream((request, response) => {
      selected.push(deployment);
      response.writeHead(202, { "content-type": "application/json", "x-eve-session-id": `eve_${++sequence}` });
      response.end(JSON.stringify({ deployment, sessionId: `eve_${sequence}`, headers: request.headers }));
    });
    const first = await makeUpstream("a");
    const second = await makeUpstream("b");
    const weighted = route({
      targets: [
        { routeId: "route_project", deploymentId: "dep_a", weight: 5_000, variantName: "a", hostPort: first.port, status: "running" },
        { routeId: "route_project", deploymentId: "dep_b", weight: 5_000, variantName: "b", hostPort: second.port, status: "running" },
      ],
    });
    const repo = repository([weighted]);
    const app = createGatewayApp(repo, { allowedBaseDomains: ["agent.localhost"], affinitySecret });

    const initial = await app.request("https://p-alpha.agent.localhost/eve/v1/session", {
      method: "POST",
      headers: { host: "p-alpha.agent.localhost", "content-type": "application/json" },
      body: "{}",
    });
    const affinityCookie = initial.headers.getSetCookie().find((value) => value.startsWith("eveland_affinity="));
    expect(affinityCookie).toMatch(/; Domain=agent\.localhost; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
    const cookiePair = affinityCookie!.split(";", 1)[0]!;

    const replay = await app.request("https://p-alpha.agent.localhost/eve/v1/session", {
      method: "POST",
      headers: { host: "p-alpha.agent.localhost", cookie: `${cookiePair}; app_session=user`, "content-type": "application/json" },
      body: "{}",
    });

    const replayBody = await replay.json() as { headers: Record<string, string> };
    expect(replay.headers.getSetCookie().some((value) => value.startsWith("eveland_affinity="))).toBe(false);
    expect(replayBody.headers.cookie).toBe("app_session=user");
    expect(selected[1]).toBe(selected[0]);
    expect(repo.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ affinitySource: "generated", affinityFingerprint: expect.stringMatching(/^sha256-[a-f0-9]{64}$/) }),
      expect.objectContaining({ affinitySource: "cookie", affinityFingerprint: expect.stringMatching(/^sha256-[a-f0-9]{64}$/) }),
    ]));
    expect(JSON.stringify(repo.bindings)).not.toContain(cookiePair.split("=", 2)[1]);

    const [name, value] = cookiePair.split("=", 2);
    const tampered = `${name}=${value!.slice(0, -1)}${value!.endsWith("A") ? "B" : "A"}`;
    const rejectedTamper = await app.request("https://p-alpha.agent.localhost/eve/v1/session", {
      method: "POST",
      headers: { host: "p-alpha.agent.localhost", cookie: tampered, "content-type": "application/json" },
      body: "{}",
    });
    expect(rejectedTamper.headers.getSetCookie().some((entry) => entry.startsWith("eveland_affinity="))).toBe(true);

    const malformed = await app.request("https://p-alpha.agent.localhost/eve/v1/session", {
      method: "POST",
      headers: { host: "p-alpha.agent.localhost", cookie: "eveland_affinity=%", "content-type": "application/json" },
      body: "{}",
    });
    expect(malformed.status).toBe(202);
    expect(malformed.headers.getSetCookie().some((entry) => entry.startsWith("eveland_affinity="))).toBe(true);
  });

  test("rejects request bodies over the configured limit before proxying", async () => {
    let upstreamRequests = 0;
    const upstream = await startUpstream((_request, response) => {
      upstreamRequests += 1;
      response.end("unexpected");
    });
    const app = createGatewayApp(repository([route({ hostPort: upstream.port })]), {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      maxRequestBodyBytes: 4,
    });

    const response = await app.request("http://p-alpha.agent.localhost/custom-channel", {
      method: "POST",
      headers: { host: "p-alpha.agent.localhost", "content-type": "text/plain" },
      body: "12345",
    });

    expect(response.status).toBe(413);
    expect(upstreamRequests).toBe(0);
  });

  test("cancels the upstream request promptly when the downstream signal aborts", async () => {
    let markStarted!: () => void;
    let markClosed!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const closed = new Promise<void>((resolve) => { markClosed = resolve; });
    const upstream = await startUpstream((_request, response) => {
      markStarted();
      response.once("close", markClosed);
      setTimeout(() => response.end("late"), 500);
    });
    const app = createGatewayApp(repository([route({ hostPort: upstream.port })]), {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
    });
    const controller = new AbortController();
    const pending = app.request("http://p-alpha.agent.localhost/slow", {
      headers: { host: "p-alpha.agent.localhost" },
      signal: controller.signal,
    });
    await started;
    const abortedAt = Date.now();

    controller.abort();
    const response = await pending;

    expect(response.status).toBe(499);
    expect(Date.now() - abortedAt).toBeLessThan(200);
    await expect(Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("upstream stayed open")), 200))])).resolves.toBeUndefined();
  });

  test("closes the upstream response when a real downstream socket disconnects", async () => {
    let markUpstreamClosed!: () => void;
    const upstreamClosed = new Promise<void>((resolve) => { markUpstreamClosed = resolve; });
    const upstream = await startUpstream((_request, response) => {
      response.once("close", markUpstreamClosed);
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write('{"type":"turn.started"}\n');
    });
    const app = createGatewayApp(repository([route({ hostPort: upstream.port })]), {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
    });
    const gateway = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    gatewayServers.push(gateway);
    if (!gateway.listening) await new Promise<void>((resolve) => gateway.once("listening", resolve));
    const address = gateway.address();
    if (!address || typeof address === "string") throw new Error("Gateway fixture did not bind.");

    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(
        { hostname: "127.0.0.1", port: address.port, path: "/eve/v1/session/eve_1/stream", headers: { host: "p-alpha.agent.localhost" } },
        (response) => {
          response.once("data", () => {
            response.destroy();
            resolve();
          });
        },
      );
      request.once("error", reject);
      request.end();
    });

    await expect(Promise.race([
      upstreamClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("upstream survived downstream disconnect")), 500)),
    ])).resolves.toBeUndefined();
  });

  test("keeps the privileged Playground path service-authenticated and uses loopback Host", async () => {
    const seenHosts: string[] = [];
    const upstream = await startUpstream((request, response) => {
      seenHosts.push(request.headers.host ?? "");
      if (request.method === "POST") {
        response.writeHead(202, { "content-type": "application/json", "x-eve-session-id": "eve_playground" });
        response.end(JSON.stringify({ sessionId: "eve_playground", continuationToken: "continue_1" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write(`${JSON.stringify({ type: "message.completed", data: { message: "Playground answer" } })}\n`);
      response.end(`${JSON.stringify({ type: "turn.completed", data: { turnId: "turn_0" } })}\n`);
    });
    const repo = repository([route({ hostPort: upstream.port })]);
    const app = createGatewayApp(repo, {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      internalServiceToken: "service-secret",
    });

    const unauthorized = await app.request("http://gateway/internal/projects/proj_1/playground", { method: "POST" });
    const response = await app.request("http://gateway/internal/projects/proj_1/playground", {
      method: "POST",
      headers: { authorization: "Bearer service-secret", "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });

    expect(unauthorized.status).toBe(404);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      response: "Playground answer",
      eveSessionId: "eve_playground",
      continuationToken: "continue_1",
      events: [expect.objectContaining({ type: "message.completed" }), expect.objectContaining({ type: "turn.completed" })],
    });
    expect(seenHosts).toEqual([`localhost:${upstream.port}`, `localhost:${upstream.port}`]);
    expect(repo.bindings).toContainEqual(expect.objectContaining({ eveSessionId: "eve_playground", trigger: "playground" }));
  });

  test("invalidates cached Host resolution through the service-authenticated control path", async () => {
    const first = await startUpstream((_request, response) => response.end("first"));
    const second = await startUpstream((_request, response) => response.end("second"));
    const routes = [route({ hostPort: first.port })];
    const app = createGatewayApp(repository(routes), {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      internalServiceToken: "service-secret",
      routeCacheTtlMs: 60_000,
    });

    await expect((await app.request("http://p-alpha.agent.localhost/", { headers: { host: "p-alpha.agent.localhost" } })).text()).resolves.toBe(
      "first",
    );
    routes.splice(0, 1, route({ hostPort: second.port }));
    await expect((await app.request("http://p-alpha.agent.localhost/", { headers: { host: "p-alpha.agent.localhost" } })).text()).resolves.toBe(
      "first",
    );
    const invalidate = await app.request("http://gateway/internal/cache/invalidate", {
      method: "POST",
      headers: { authorization: "Bearer service-secret", "content-type": "application/json" },
      body: JSON.stringify({ hostname: "p-alpha.agent.localhost" }),
    });
    expect(invalidate.status).toBe(200);
    await expect((await app.request("http://p-alpha.agent.localhost/", { headers: { host: "p-alpha.agent.localhost" } })).text()).resolves.toBe(
      "second",
    );
  });
});

function route(
  overrides: Partial<ResolvedAgentRoute> & {
    hostPort?: number;
    deploymentStatus?: ResolvedAgentRoute["targets"][number]["status"];
  } = {},
): ResolvedAgentRoute {
  const { hostPort = 41999, deploymentStatus = "running", ...routeOverrides } = overrides;
  return {
    id: "route_project",
    projectId: "proj_1",
    hostname: "p-alpha.agent.localhost",
    kind: "project",
    enabled: true,
    policyRevision: 1,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    targets: [
      {
        routeId: overrides.id ?? "route_project",
        deploymentId: "dep_1",
        weight: 10_000,
        variantName: null,
        hostPort,
        status: deploymentStatus,
      },
    ],
    ...routeOverrides,
  };
}

function repository(routes: ResolvedAgentRoute[]): GatewayRepository & { bindings: Array<Record<string, unknown>> } {
  const bindings: Array<Record<string, unknown>> = [];
  const deployments = new Map(
    routes.flatMap((route) => route.targets).map((target) => [target.deploymentId, {
      id: target.deploymentId,
      deploymentKey: `d-${target.deploymentId}`,
      projectId: "proj_1",
      releaseId: `rel-${target.deploymentId}`,
      containerName: target.deploymentId,
      internalPort: 3000,
      hostPort: target.hostPort,
      status: target.status,
      runtimeKind: "docker" as const,
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z",
    }] as const),
  );
  return {
    bindings,
    async findRouteByHostname(hostname) {
      return routes.find((candidate) => candidate.hostname === hostname) ?? null;
    },
    async findProjectRoute(projectId) {
      return routes.find((candidate) => candidate.projectId === projectId && candidate.kind === "project") ?? null;
    },
    async getDeployment(deploymentId) {
      return deployments.get(deploymentId) ?? null;
    },
    async findSessionBinding(projectId, eveSessionId) {
      return (bindings.find((binding) => binding.projectId === projectId && binding.eveSessionId === eveSessionId) as never) ?? null;
    },
    async bindSession(input) {
      bindings.push(input);
    },
  };
}

async function startUpstream(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ port: number }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Upstream fixture did not bind.");
  return { port: address.port };
}
