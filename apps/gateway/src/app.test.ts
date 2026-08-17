import { createServer } from "node:http";
import { describe, expect, test, vi } from "vitest";
import { createBuildInfo } from "@evelandhq/core/build-info";
import { createConfigurationSnapshot } from "@evelandhq/core/config-diagnostics";
import { createGatewayApp, type GatewayRepository } from "./app.js";
import {
  affinitySecret,
  registerGatewayTestCleanup,
  repository,
  route,
  startUpstream,
} from "./app.test-support.js";

registerGatewayTestCleanup();

describe("Gateway", () => {
  test("returns the Eveland product and Gateway build identity", async () => {
    const buildInfo = createBuildInfo("gateway", {
      revision: "6bb1d53f51ab",
      channel: "stable",
    });
    const app = createGatewayApp(repository([]), {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      buildInfo,
    });

    const response = await app.request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, ...buildInfo });
  });

  test("keeps the masked configuration snapshot behind the internal service boundary", async () => {
    const configurationSnapshot = createConfigurationSnapshot("gateway", {
      EVELAND_GATEWAY_AFFINITY_SECRET: "never-return-this-secret",
    });
    const app = createGatewayApp(repository([]), {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      internalServiceToken: "service-token",
      configurationSnapshot,
    });

    expect((await app.request("/internal/diagnostics/config")).status).toBe(404);
    const response = await app.request("/internal/diagnostics/config", {
      headers: { authorization: "Bearer service-token" },
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual(configurationSnapshot);
    expect(body).not.toContain("never-return-this-secret");
    expect(await (await app.request("/health")).text()).not.toContain("entries");
  });

  test("fails closed on missing affinity signing material or invalid body limits", () => {
    expect(() =>
      createGatewayApp(repository([]), {
        allowedBaseDomains: ["agent.localhost"],
        affinitySecret: "",
      }),
    ).toThrow(/affinity secret/i);
    expect(() =>
      createGatewayApp(repository([]), {
        allowedBaseDomains: ["agent.localhost"],
        affinitySecret,
        maxRequestBodyBytes: -1,
      }),
    ).toThrow(/request body limit/i);
  });

  test("routes stable and immutable preview hosts to their selected deployment", async () => {
    const upstream = await startUpstream((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ path: request.url, host: request.headers.host }));
    });
    const stable = route({ hostname: "p-alpha.agent.localhost", hostPort: upstream.port });
    const preview = route({
      id: "route_preview",
      hostname: "d-v1--p-alpha.agent.localhost",
      kind: "deployment",
      hostPort: upstream.port,
    });
    const app = createGatewayApp(repository([stable, preview]), {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
    });

    const stableResponse = await app.request("http://p-alpha.agent.localhost/eve/v1/health", {
      headers: { host: "p-alpha.agent.localhost:4080" },
    });
    const previewResponse = await app.request("http://d-v1--p-alpha.agent.localhost/custom", {
      headers: { host: "d-v1--p-alpha.agent.localhost:4080" },
    });

    expect(stableResponse.status).toBe(200);
    await expect(stableResponse.json()).resolves.toEqual({
      path: "/eve/v1/health",
      host: "p-alpha.agent.localhost:4080",
    });
    await expect(previewResponse.json()).resolves.toEqual({
      path: "/custom",
      host: "d-v1--p-alpha.agent.localhost:4080",
    });
  });

  test("fails closed on non-canonical requests in the public Eve session namespace", async () => {
    let upstreamRequests = 0;
    const upstream = await startUpstream((_request, response) => {
      upstreamRequests += 1;
      response.end("unexpected");
    });
    const activationClient = {
      activate: vi.fn(async () => ({
        leaseId: "lease_unexpected",
        endpointPort: upstream.port,
      })),
      renew: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    };
    const app = createGatewayApp(repository([route({ hostPort: upstream.port })]), {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      activationClient,
    });

    for (const request of [
      { method: "POST", path: "/eve/v1/session/" },
      { method: "GET", path: "/eve/v1/session/eve_1" },
      { method: "POST", path: "/eve/v1/session/eve_1/" },
      { method: "POST", path: "/eve/v1/session/eve_1/unknown" },
      { method: "POST", path: "/eve/v1/session/%E0%A4%A" },
    ]) {
      const response = await app.request(`http://p-alpha.agent.localhost${request.path}`, {
        method: request.method,
        headers: { host: "p-alpha.agent.localhost" },
      });
      expect(response.status, `${request.method} ${request.path}`).toBe(404);
    }

    expect(activationClient.activate).not.toHaveBeenCalled();
    expect(upstreamRequests).toBe(0);
  });

  test("rejects public Eve session traffic for the selected unsupported deployment before proxy or activation", async () => {
    let upstreamRequests = 0;
    const upstream = await startUpstream((_request, response) => {
      upstreamRequests += 1;
      response.end("unexpected");
    });
    const routed = route({ hostPort: upstream.port });
    const repo = repository([routed]);
    repo.bindings.push({
      id: "bind_old_eve",
      projectId: routed.projectId,
      eveSessionId: "eve_old",
      routeId: routed.id,
      deploymentId: "dep_1",
      trigger: "api",
      variantName: null,
      experimentId: null,
      requestId: "req_original",
      remoteIp: null,
      affinityFingerprint: null,
      affinitySource: null,
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    });
    repo.getDeploymentEveVersion = vi.fn(async () => ({
      version: "0.22.6",
      expected: "0.38.x or 0.39.x" as const,
      supportedRanges: ["0.38.x", "0.39.x"] as const,
      supported: false,
      sourceRevisionId: "src_old",
    }));
    const activationClient = {
      activate: vi.fn(async () => ({ leaseId: "lease_unexpected", endpointPort: upstream.port })),
      renew: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    };
    const app = createGatewayApp(repo, {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      activationClient,
      now: () => new Date("2026-07-16T00:00:00.000Z"),
    });

    for (const request of [
      { method: "POST", path: "/eve/v1/session" },
      { method: "POST", path: "/eve/v1/session/eve_old" },
      { method: "POST", path: "/eve/v1/session/eve_old/cancel" },
      { method: "GET", path: "/eve/v1/session/eve_old/stream" },
    ]) {
      const response = await app.request(`http://p-alpha.agent.localhost${request.path}`, {
        method: request.method,
        headers: { host: "p-alpha.agent.localhost" },
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: "Unsupported Eve version",
        detail:
          'Unsupported Eve dependency "0.22.6". Eveland requires Eve 0.38.x or 0.39.x. Upgrade the project\'s "eve" dependency before importing or deploying.',
        eveVersion: {
          version: "0.22.6",
          expected: "0.38.x or 0.39.x",
          supportedRanges: ["0.38.x", "0.39.x"],
          supported: false,
          sourceRevisionId: "src_old",
        },
      });
    }

    expect(repo.getDeploymentEveVersion).toHaveBeenCalledTimes(4);
    expect(repo.getDeploymentEveVersion).toHaveBeenCalledWith("dep_1");
    expect(activationClient.activate).not.toHaveBeenCalled();
    expect(upstreamRequests).toBe(0);
  });

  test("hides unknown and disabled hosts, and reports routes without a running target", async () => {
    const disabled = route({ hostname: "p-disabled.agent.localhost", enabled: false });
    const stopped = route({ hostname: "p-stopped.agent.localhost", deploymentStatus: "stopped" });
    const app = createGatewayApp(repository([disabled, stopped]), {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
    });

    expect(
      (await app.request("http://unknown.invalid/", { headers: { host: "unknown.invalid" } }))
        .status,
    ).toBe(404);
    expect(
      (
        await app.request("http://p-missing.agent.localhost/", {
          headers: { host: "p-missing.agent.localhost" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request("http://p-disabled.agent.localhost/", {
          headers: { host: "p-disabled.agent.localhost" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request("http://p-stopped.agent.localhost/", {
          headers: { host: "p-stopped.agent.localhost" },
        })
      ).status,
    ).toBe(503);
  });

  test("wakes a stopped target before proxying and releases its request lease after the response body", async () => {
    const upstream = await startUpstream((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () =>
        response.end(`${request.headers.authorization}:${Buffer.concat(chunks).toString("utf8")}`),
      );
    });
    const activationClient = {
      activate: vi.fn(async () => ({ leaseId: "lease_gateway", endpointPort: upstream.port })),
      renew: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    };
    const app = createGatewayApp(
      repository([route({ hostPort: upstream.port, deploymentStatus: "stopped" })]),
      {
        allowedBaseDomains: ["agent.localhost"],
        affinitySecret,
        activationClient,
      },
    );

    const response = await app.request("http://p-alpha.agent.localhost/channels/webhook", {
      method: "POST",
      headers: {
        host: "p-alpha.agent.localhost",
        authorization: "Bearer agent-owned",
        "content-type": "text/plain",
      },
      body: "wake-body",
    });

    expect(activationClient.activate).toHaveBeenCalledWith(
      expect.objectContaining({
        deploymentId: "dep_1",
        kind: "public_request",
      }),
      expect.any(AbortSignal),
    );
    expect(activationClient.release).not.toHaveBeenCalled();
    await expect(response.text()).resolves.toBe("Bearer agent-owned:wake-body");
    expect(activationClient.release).toHaveBeenCalledWith("lease_gateway");
  });

  test("renews an activation lease while a response stream is active", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write(`${JSON.stringify({ type: "message.appended" })}\n`);
      setTimeout(() => response.end(`${JSON.stringify({ type: "turn.completed" })}\n`), 30);
    });
    const activationClient = {
      activate: vi.fn(async () => ({ leaseId: "lease_stream", endpointPort: upstream.port })),
      renew: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    };
    const app = createGatewayApp(
      repository([route({ hostPort: upstream.port, deploymentStatus: "stopped" })]),
      {
        allowedBaseDomains: ["agent.localhost"],
        affinitySecret,
        activationClient,
        activationRenewIntervalMs: 5,
      },
    );

    const response = await app.request(
      "http://p-alpha.agent.localhost/eve/v1/session/eve_stream/stream",
      {
        headers: { host: "p-alpha.agent.localhost", accept: "application/x-ndjson" },
      },
    );
    await expect(response.text()).resolves.toContain("turn.completed");

    expect(activationClient.renew).toHaveBeenCalledWith("lease_stream");
    expect(activationClient.release).toHaveBeenCalledWith("lease_stream");
  });

  test("returns 499 when the client aborts a cold activation", async () => {
    const controller = new AbortController();
    let activationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      activationStarted = resolve;
    });
    const activationClient = {
      activate: vi.fn(
        (_input: unknown, signal: AbortSignal) =>
          new Promise<never>((_resolve, reject) => {
            activationStarted();
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          }),
      ),
      renew: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    };
    const app = createGatewayApp(repository([route({ deploymentStatus: "stopped" })]), {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      activationClient,
    });

    const pending = app.request("http://p-alpha.agent.localhost/custom", {
      headers: { host: "p-alpha.agent.localhost" },
      signal: controller.signal,
    });
    await started;
    controller.abort();

    expect((await pending).status).toBe(499);
    expect(activationClient.release).not.toHaveBeenCalled();
  });

  test("wakes the SessionBinding deployment instead of re-running route weighting", async () => {
    const current = await startUpstream((_request, response) => response.end("current"));
    const bound = await startUpstream((_request, response) => response.end("bound"));
    const routed = route({
      targets: [
        {
          routeId: "route_project",
          deploymentId: "dep_current",
          weight: 10_000,
          variantName: "current",
          hostPort: current.port,
          status: "running",
        },
        {
          routeId: "route_project",
          deploymentId: "dep_bound",
          weight: 0,
          variantName: "previous",
          hostPort: bound.port,
          status: "stopped",
        },
      ],
    });
    const repo = repository([routed]);
    repo.getDeploymentEveVersion = vi.fn(repo.getDeploymentEveVersion);
    repo.bindings.push({
      id: "bind_stopped",
      projectId: routed.projectId,
      eveSessionId: "eve_stopped_bound",
      routeId: routed.id,
      deploymentId: "dep_bound",
      trigger: "api",
      variantName: "previous",
      experimentId: "route_project:r0",
      requestId: "req_original",
      remoteIp: null,
      affinityFingerprint: null,
      affinitySource: null,
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    });
    const activationClient = {
      activate: vi.fn(async () => ({ leaseId: "lease_bound", endpointPort: bound.port })),
      renew: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    };
    const app = createGatewayApp(repo, {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      activationClient,
      now: () => new Date("2026-07-16T00:00:00.000Z"),
    });

    const response = await app.request(
      "http://p-alpha.agent.localhost/eve/v1/session/eve_stopped_bound",
      {
        method: "POST",
        headers: { host: "p-alpha.agent.localhost" },
      },
    );

    await expect(response.text()).resolves.toBe("bound");
    expect(activationClient.activate).toHaveBeenCalledWith(
      expect.objectContaining({
        deploymentId: "dep_bound",
        kind: "turn",
      }),
      expect.any(AbortSignal),
    );
    expect(repo.getDeploymentEveVersion).toHaveBeenCalledWith("dep_bound");
  });

  test("preserves Agent auth and cookies while rebuilding spoofable forwarding headers", async () => {
    const upstream = await startUpstream((request, response) => {
      response.setHeader("set-cookie", ["eve_session=abc; HttpOnly", "variant=v1; HttpOnly"]);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(request.headers));
    });
    const app = createGatewayApp(repository([route({ hostPort: upstream.port })]), {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
    });

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
    expect(response.headers.getSetCookie()).toEqual([
      "eve_session=abc; HttpOnly",
      "variant=v1; HttpOnly",
    ]);
  });

  test("never hands a public Agent a loopback authority, however the caller spoofs", async () => {
    const upstream = await startUpstream((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(request.headers));
    });
    const app = createGatewayApp(
      repository([route({ hostname: "p-alpha.agents.example.com", hostPort: upstream.port })]),
      { allowedBaseDomains: ["agents.example.com"], affinitySecret },
    );

    const response = await app.request("http://p-alpha.agents.example.com/eve/v1/session", {
      method: "POST",
      headers: {
        host: "p-alpha.agents.example.com",
        "content-type": "application/json",
        "x-forwarded-host": "localhost",
        "x-forwarded-for": "127.0.0.1",
        forwarded: "host=localhost;for=127.0.0.1",
      },
      body: JSON.stringify({ message: "hello" }),
    });
    const headers = (await response.json()) as Record<string, string>;

    // Eve 0.32 stopped reading the request Host in localDev(), so no Agent in
    // the supported window still authorizes on a loopback name -- the original
    // Host-spoof bypass is closed upstream. This stays as defense in depth
    // because it is the Gateway's invariant either way: the Playground reaches
    // an Agent over loopback deliberately, and public traffic must never be
    // able to imitate it.
    const loopback = /^(localhost|127\.|\[::1\])/;
    expect(headers.host).toBe("p-alpha.agents.example.com");
    expect(headers.host).not.toMatch(loopback);
    expect(headers["x-forwarded-host"]).toBe("p-alpha.agents.example.com");
    expect(headers["x-forwarded-host"]).not.toMatch(loopback);
    expect(headers.forwarded).toContain("host=");
    expect(headers.forwarded).not.toContain("localhost");
  });

  test("transparently forwards Agent authentication challenges", async () => {
    const challenge =
      'Bearer realm="eveland", authorization_uri="https://identity.example.com/identity/login", project_id="proj_agent", display_name="Eveland"';
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(401, {
        "cache-control": "no-store",
        "content-type": "application/json",
        "www-authenticate": challenge,
      });
      response.end(
        JSON.stringify({
          code: "authentication_required",
          error: "Eveland authentication is required.",
        }),
      );
    });
    const app = createGatewayApp(repository([route({ hostPort: upstream.port })]), {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
    });

    const response = await app.request("http://p-alpha.agent.localhost/eve/v1/session", {
      method: "POST",
      headers: {
        host: "p-alpha.agent.localhost",
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "hello" }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(challenge);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      code: "authentication_required",
      error: "Eveland authentication is required.",
    });
  });
});

describe("Gateway resource bounds", () => {
  test("evicts old route cache entries instead of growing without limit", async () => {
    const lookups: string[] = [];
    const base = repository([]);
    const counting: GatewayRepository = {
      ...base,
      async findRouteByHostname(hostname: string) {
        lookups.push(hostname);
        return base.findRouteByHostname(hostname);
      },
    };
    const app = createGatewayApp(counting, {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      routeCacheTtlMs: 60_000,
      routeCacheMaxEntries: 4,
    });

    const host = (index: number) => `probe-${index}.agent.localhost`;
    for (let index = 0; index < 6; index += 1) {
      await app.request("/", { headers: { host: host(index) } });
    }
    // Cached: repeating a recent hostname must not hit the repository again.
    const beforeRepeat = lookups.length;
    await app.request("/", { headers: { host: host(5) } });
    expect(lookups.length).toBe(beforeRepeat);

    // Evicted: the oldest hostname is gone even though its TTL has not expired,
    // which is what keeps unknown-subdomain traffic from growing the Map.
    await app.request("/", { headers: { host: host(0) } });
    expect(lookups.filter((hostname) => hostname === host(0))).toHaveLength(2);
  });

  test("gives up on an upstream that accepts the connection and never responds", async () => {
    const upstream = createServer(() => {
      // Accept and hang: no status line, no body, ever.
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address.");

    try {
      const app = createGatewayApp(repository([route({ hostPort: address.port })]), {
        allowedBaseDomains: ["agent.localhost"],
        affinitySecret,
        upstreamTimeoutMs: 300,
      });

      const started = Date.now();
      const response = await app.request("/eve/v1/health", {
        headers: { host: "p-alpha.agent.localhost" },
      });

      // Without an idle timeout this request holds the client, the socket, and
      // the deployment's renewing activation lease indefinitely.
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});

describe("internal surface gate", () => {
  test("gates every /internal path, including unregistered ones, before the public pipeline", async () => {
    const app = createGatewayApp(repository([]), {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      internalServiceToken: "service-token",
    });

    // Unauthenticated: the masked internal 404, not a public-pipeline error.
    const unauthenticated = await app.request("/internal/never-registered");
    expect(unauthenticated.status).toBe(404);
    await expect(unauthenticated.json()).resolves.toEqual({ error: "Not found" });

    // Authenticated but unregistered: still terminated inside the internal
    // surface -- it must never fall through to the public proxy catch-all.
    const authenticated = await app.request("/internal/never-registered", {
      headers: { authorization: "Bearer service-token" },
    });
    expect(authenticated.status).toBe(404);
    await expect(authenticated.json()).resolves.toEqual({ error: "Not found" });
  });
});
