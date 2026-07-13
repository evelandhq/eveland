import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { createGatewayApp, type GatewayRepository, type ResolvedAgentRoute } from "./app.js";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("Gateway", () => {
  test("routes stable and immutable preview hosts to their selected deployment", async () => {
    const upstream = await startUpstream((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ path: request.url, host: request.headers.host }));
    });
    const stable = route({ hostname: "p-alpha.agent.localhost", hostPort: upstream.port });
    const preview = route({ id: "route_preview", hostname: "d-v1--p-alpha.agent.localhost", kind: "deployment", hostPort: upstream.port });
    const app = createGatewayApp(repository([stable, preview]), { allowedBaseDomains: ["agent.localhost"] });

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
    const app = createGatewayApp(repository([disabled, stopped]), { allowedBaseDomains: ["agent.localhost"] });

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
    const app = createGatewayApp(repository([route({ hostPort: upstream.port })]), { allowedBaseDomains: ["agent.localhost"] });

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
    expect(response.headers.getSetCookie()).toEqual(["eve_session=abc; HttpOnly", "variant=v1; HttpOnly"]);
  });

  test("streams the first NDJSON chunk without waiting for the upstream session to finish", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write('{"type":"turn.started"}\n');
      setTimeout(() => response.end('{"type":"turn.completed"}\n'), 250);
    });
    const app = createGatewayApp(repository([route({ hostPort: upstream.port })]), { allowedBaseDomains: ["agent.localhost"] });
    const startedAt = Date.now();
    const response = await app.request("http://p-alpha.agent.localhost/eve/v1/session/eve_1/stream", {
      headers: { host: "p-alpha.agent.localhost:4080" },
    });
    const reader = response.body!.getReader();
    const first = await reader.read();

    expect(new TextDecoder().decode(first.value)).toContain("turn.started");
    expect(Date.now() - startedAt).toBeLessThan(200);
    await reader.cancel();
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
    const app = createGatewayApp(repo, { allowedBaseDomains: ["agent.localhost"] });

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
  return {
    bindings,
    async findRouteByHostname(hostname) {
      return routes.find((candidate) => candidate.hostname === hostname) ?? null;
    },
    async findProjectRoute(projectId) {
      return routes.find((candidate) => candidate.projectId === projectId && candidate.kind === "project") ?? null;
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
