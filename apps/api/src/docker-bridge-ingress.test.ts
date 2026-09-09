import { describe, expect, test, vi } from "vitest";
import {
  createDockerBridgeIngress,
  type DockerBridgeServer,
  dockerBridgeRetryDelayMs,
  resolveDockerBridgeBindHost,
  startDockerBridgeListener,
} from "./docker-bridge-ingress.js";

describe("Docker bridge API ingress", () => {
  test("is disabled unless a private bridge address is configured", () => {
    expect(resolveDockerBridgeBindHost({})).toBeUndefined();
    expect(resolveDockerBridgeBindHost({ EVELAND_API_DOCKER_BRIDGE_HOST: "172.17.0.1" })).toBe(
      "172.17.0.1",
    );
  });

  test.each(["0.0.0.0", "127.0.0.1", "8.8.8.8", "host.docker.internal"])(
    "rejects unsafe bind host %s",
    (host) => {
      expect(() => resolveDockerBridgeBindHost({ EVELAND_API_DOCKER_BRIDGE_HOST: host })).toThrow(
        /private Docker bridge IPv4 address/,
      );
    },
  );

  test("rejects a primary API listener that already covers the bridge", () => {
    expect(() =>
      resolveDockerBridgeBindHost({
        EVELAND_API_BIND_HOST: "0.0.0.0",
        EVELAND_API_DOCKER_BRIDGE_HOST: "172.17.0.1",
      }),
    ).toThrow(/separate loopback EVELAND_API_BIND_HOST/);
  });

  test("serves the same listener in production — the invariants, not NODE_ENV, are the boundary", () => {
    // The Linux production form runs the API as a host process, so this is
    // the ONLY path from the bridged Collector to the API. What keeps it safe
    // there is what keeps it safe in development: a private address, a
    // separate loopback primary, and the path allowlist below.
    expect(
      resolveDockerBridgeBindHost({
        NODE_ENV: "production",
        EVELAND_API_DOCKER_BRIDGE_HOST: "172.17.0.1",
      }),
    ).toBe("172.17.0.1");
  });

  test.each(["0.0.0.0", "127.0.0.1", "8.8.8.8", "host.docker.internal"])(
    "still rejects unsafe bind host %s in production",
    (host) => {
      expect(() =>
        resolveDockerBridgeBindHost({
          NODE_ENV: "production",
          EVELAND_API_DOCKER_BRIDGE_HOST: host,
        }),
      ).toThrow(/private Docker bridge IPv4 address/);
    },
  );

  test("still requires a separate loopback primary listener in production", () => {
    expect(() =>
      resolveDockerBridgeBindHost({
        NODE_ENV: "production",
        EVELAND_API_BIND_HOST: "0.0.0.0",
        EVELAND_API_DOCKER_BRIDGE_HOST: "172.17.0.1",
      }),
    ).toThrow(/separate loopback EVELAND_API_BIND_HOST/);
  });

  test.each([
    ["GET", "/health"],
    ["POST", "/internal/otel/v1/logs"],
    ["POST", "/internal/otel/v1/metrics"],
    ["POST", "/internal/observability/destinations/dst_1/v1/logs"],
    ["GET", "/.well-known/jwks.json"],
    ["POST", "/internal/scheduler/dispatch"],
  ])("forwards %s %s to the API", async (method, pathname) => {
    const apiFetch = vi.fn(async () => new Response("accepted", { status: 202 }));
    const ingress = createDockerBridgeIngress(apiFetch);
    const request = new Request(`http://172.17.0.1:17301${pathname}`, { method });

    const response = await ingress(request);

    expect(response.status).toBe(202);
    expect(apiFetch).toHaveBeenCalledOnce();
    expect(apiFetch).toHaveBeenCalledWith(request);
  });

  test.each([
    "/api/projects",
    "/internal/scheduler/dispatch/extra",
    "/.well-known/jwks.json/extra",
    "/internal/otel-malicious/v1/logs",
  ])("returns 404 without forwarding %s", async (pathname) => {
    const apiFetch = vi.fn(async () => new Response("unexpected"));
    const ingress = createDockerBridgeIngress(apiFetch);

    const response = await ingress(new Request(`http://172.17.0.1:17301${pathname}`));

    expect(response.status).toBe(404);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe("Docker bridge listener retry", () => {
  type FakeServer = DockerBridgeServer & {
    fail(code: string): void;
    listen(): void;
    closed: number;
  };

  function fakeServer(onListening: () => void): FakeServer {
    let onError: ((error: NodeJS.ErrnoException) => void) | undefined;
    const server: FakeServer = {
      closed: 0,
      on(_event, listener) {
        onError = listener;
        return server;
      },
      close() {
        server.closed += 1;
        return server;
      },
      fail(code) {
        onError?.(Object.assign(new Error(code), { code }));
      },
      listen: onListening,
    };
    return server;
  }

  function harness() {
    const servers: FakeServer[] = [];
    const timers: { callback: () => void; ms: number; unref: ReturnType<typeof vi.fn> }[] = [];
    const log = { listening: vi.fn(), bindFailed: vi.fn() };
    const handle = startDockerBridgeListener({
      address: "172.17.0.1:17301",
      serve: (onListening) => {
        const server = fakeServer(onListening);
        servers.push(server);
        return server;
      },
      log,
      schedule: (callback, ms) => {
        const timer = { callback, ms, unref: vi.fn() };
        timers.push(timer);
        return timer;
      },
    });
    return { servers, timers, log, handle };
  }

  test("keeps retrying EADDRNOTAVAIL with a growing delay until the bridge appears", () => {
    // The boot-order race: docker0 does not exist when the API starts and
    // shows up a few seconds later. One failure used to mean no Collector
    // ingress until someone restarted the API by hand.
    const { servers, timers, log } = harness();
    expect(servers).toHaveLength(1);

    servers[0]!.fail("EADDRNOTAVAIL");
    expect(servers[0]!.closed).toBe(1);
    expect(log.bindFailed).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: "EADDRNOTAVAIL", attempt: 1, retryInMs: 1_000 }),
    );
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(1_000);
    // A retry timer must never keep the process alive on its own.
    expect(timers[0]!.unref).toHaveBeenCalled();

    timers[0]!.callback();
    expect(servers).toHaveLength(2);
    servers[1]!.fail("EADDRNOTAVAIL");
    expect(timers[1]!.ms).toBe(2_000);

    timers[1]!.callback();
    servers[2]!.listen();
    expect(log.listening).toHaveBeenCalledTimes(1);
    expect(log.listening).toHaveBeenCalledWith("172.17.0.1:17301");
    expect(timers).toHaveLength(2);
  });

  test("stop() cancels the pending retry", () => {
    const { servers, timers, handle, log } = harness();
    servers[0]!.fail("EADDRNOTAVAIL");
    handle.stop();
    timers[0]!.callback();
    expect(servers).toHaveLength(1);
    expect(log.listening).not.toHaveBeenCalled();
  });

  test("the delay doubles from one second and caps at thirty", () => {
    expect([1, 2, 3, 5, 6, 20].map(dockerBridgeRetryDelayMs)).toEqual([
      1_000, 2_000, 4_000, 16_000, 30_000, 30_000,
    ]);
  });
});
