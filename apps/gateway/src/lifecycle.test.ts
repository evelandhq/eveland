import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createGatewayLifecycle } from "./lifecycle.js";
import type { RouteSource } from "./route-source.js";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe("gateway lifecycle", () => {
  test("closes the route source after existing requests drain naturally", async () => {
    const closeRouteSource = vi.fn(async () => {});
    const server = createServer((_req, res) => res.end("ok"));
    const lifecycle = createGatewayLifecycle({ server, routeSource: makeRouteSource(closeRouteSource), shutdownGraceMs: 100 });
    const port = await listen(server);

    await expect(fetch(`http://127.0.0.1:${port}/`).then((response) => response.text())).resolves.toBe("ok");
    await lifecycle.shutdown();

    expect(lifecycle.activeSocketCount()).toBe(0);
    expect(closeRouteSource).toHaveBeenCalledTimes(1);
  });

  test("destroys active streaming sockets after the bounded grace period", async () => {
    const closeRouteSource = vi.fn(async () => {});
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write('{"type":"still-open"}\n');
    });
    const lifecycle = createGatewayLifecycle({
      server,
      routeSource: makeRouteSource(closeRouteSource),
      shutdownGraceMs: 20,
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    const port = await listen(server);

    const response = await fetch(`http://127.0.0.1:${port}/stream`);
    expect(response.status).toBe(200);
    expect(lifecycle.activeSocketCount()).toBe(1);

    await lifecycle.shutdown();

    expect(lifecycle.activeSocketCount()).toBe(0);
    expect(closeRouteSource).toHaveBeenCalledTimes(1);
  });

  test("coalesces repeated shutdown calls", async () => {
    const closeRouteSource = vi.fn(async () => {});
    const server = createServer((_req, res) => res.end("ok"));
    const lifecycle = createGatewayLifecycle({ server, routeSource: makeRouteSource(closeRouteSource), shutdownGraceMs: 100 });
    await listen(server);

    await Promise.all([lifecycle.shutdown(), lifecycle.shutdown()]);

    expect(closeRouteSource).toHaveBeenCalledTimes(1);
  });
});

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function makeRouteSource(close: () => Promise<void>): RouteSource {
  return {
    async lookup() {
      return null;
    },
    async listAgents() {
      return [];
    },
    async subscribe() {},
    close,
  };
}
