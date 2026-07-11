import { createServer, type Server } from "node:http";
import type { EventEmitter } from "node:events";
import { connect } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { createGatewayServer } from "./app.js";
import type { GatewayConfig } from "./config.js";
import type { AgentRoute, RouteSource } from "./route-source.js";

const servers: Server[] = [];
const sockets = new Set<Socket>();

afterEach(async () => {
  for (const socket of sockets) {
    socket.destroy();
  }
  sockets.clear();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function listen(server: Server): Promise<number> {
  servers.push(server);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    port: 0,
    databaseUrl: "postgres://unused",
    agentDomain: "lvh.me",
    agentUrlEnv: { EVELAND_AGENT_DOMAIN: "lvh.me", EVELAND_AGENT_URL_SCHEME: "http", EVELAND_AGENT_URL_PORT: "8080" },
    upstreamTimeoutMs: 30_000,
    routeTtlMs: 30_000,
    upstreamHostOverride: null,
    ...overrides,
  };
}

function makeRouteSource(routes: Record<string, AgentRoute | null>, options: { failLookup?: boolean } = {}): RouteSource {
  return {
    async lookup(slug) {
      if (options.failLookup) {
        throw new Error("db down");
      }
      if (!(slug in routes)) return null;
      return routes[slug] ?? null;
    },
    async listAgents() {
      return Object.values(routes)
        .filter((route): route is AgentRoute => route !== null)
        .map(({ slug, name }) => ({ slug, name }));
    },
    async subscribe() {},
    async close() {},
  };
}

async function startGateway(config: GatewayConfig, routeSource: RouteSource): Promise<number> {
  return listen(createGatewayServer({ config, routeSource }));
}

describe("gateway", () => {
  test("serves /healthz on any host before routing", async () => {
    const port = await startGateway(makeConfig(), makeRouteSource({}));
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { host: "anything.example.com" } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: "eveland-gateway" });
  });

  test("proxies method, path, query, body, and streams NDJSON chunk by chunk", async () => {
    const chunks: string[] = [];
    let firstChunkAt = 0;
    let secondChunkAt = 0;
    const upstream = createServer(async (req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/eve/v1/session?probe=1");
      expect(req.headers.host).toMatch(/^demo\.lvh\.me:\d+$/);
      let body = "";
      for await (const piece of req) body += piece;
      expect(body).toBe(JSON.stringify({ message: "hi" }));
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write('{"type":"session.started"}\n');
      setTimeout(() => {
        res.end('{"type":"turn.completed"}\n');
      }, 75);
    });
    const upstreamPort = await listen(upstream);
    const port = await startGateway(
      makeConfig(),
      makeRouteSource({ demo: { slug: "demo", name: "Demo", hostAddress: "127.0.0.1", hostPort: upstreamPort } }),
    );

    const response = await fetch(`http://demo.lvh.me:${port}/eve/v1/session?probe=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
      if (chunks.length === 1) firstChunkAt = Date.now();
      else secondChunkAt = Date.now();
    }
    expect(chunks.join("")).toBe('{"type":"session.started"}\n{"type":"turn.completed"}\n');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(secondChunkAt - firstChunkAt).toBeGreaterThanOrEqual(40);
  });

  test("injects x-forwarded-* toward the upstream", async () => {
    let seen: Record<string, unknown> = {};
    const upstream = createServer((req, res) => {
      seen = req.headers;
      res.end("ok");
    });
    const upstreamPort = await listen(upstream);
    const port = await startGateway(
      makeConfig(),
      makeRouteSource({ demo: { slug: "demo", name: "Demo", hostAddress: "127.0.0.1", hostPort: upstreamPort } }),
    );
    await fetch(`http://demo.lvh.me:${port}/`);
    expect(seen["x-forwarded-proto"]).toBe("http");
    expect(seen["x-forwarded-host"]).toMatch(/^demo\.lvh\.me:\d+$/);
    expect(String(seen["x-forwarded-for"])).toContain("127.0.0.1");
  });

  test("404 for unknown slugs and unrelated hosts", async () => {
    const port = await startGateway(makeConfig(), makeRouteSource({}));
    const unknownSlug = await fetch(`http://ghost.lvh.me:${port}/`);
    expect(unknownSlug.status).toBe(404);
    const unrelated = await fetch(`http://127.0.0.1:${port}/`);
    expect(unrelated.status).toBe(404);
  });

  test("503 for route lookup failure", async () => {
    const port = await startGateway(makeConfig(), makeRouteSource({}, { failLookup: true }));
    const response = await fetch(`http://demo.lvh.me:${port}/`);
    expect(response.status).toBe(503);
  });

  test("503 for refused upstream connections", async () => {
    const unusedPort = await getUnusedPort();
    const port = await startGateway(
      makeConfig({ upstreamTimeoutMs: 200 }),
      makeRouteSource({ demo: { slug: "demo", name: "Demo", hostAddress: "127.0.0.1", hostPort: unusedPort } }),
    );
    const response = await fetch(`http://demo.lvh.me:${port}/`);
    expect(response.status).toBe(503);
  });

  test("502 for upstream stream failures before headers", async () => {
    const upstream = createServer((req) => {
      req.socket.destroy();
    });
    const upstreamPort = await listen(upstream);
    const port = await startGateway(
      makeConfig(),
      makeRouteSource({ demo: { slug: "demo", name: "Demo", hostAddress: "127.0.0.1", hostPort: upstreamPort } }),
    );
    const response = await fetch(`http://demo.lvh.me:${port}/`);
    expect(response.status).toBe(502);
  });

  test("downstream disconnect destroys the upstream response stream", async () => {
    let upstreamSocketClosed!: Promise<void>;
    const upstream = createServer((_req, res) => {
      upstreamSocketClosed = onceEvent(res.socket!, "close");
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("first-chunk");
      const interval = setInterval(() => {
        res.write("next-chunk");
      }, 10);
      res.on("close", () => clearInterval(interval));
    });
    const upstreamPort = await listen(upstream);
    const port = await startGateway(
      makeConfig(),
      makeRouteSource({ demo: { slug: "demo", name: "Demo", hostAddress: "127.0.0.1", hostPort: upstreamPort } }),
    );

    const socket = connect(port, "127.0.0.1");
    sockets.add(socket);
    await onceEvent(socket, "connect");
    const firstChunk = waitForSocketData(socket, "first-chunk");
    socket.write("GET /stream HTTP/1.1\r\nHost: demo.lvh.me\r\nConnection: close\r\n\r\n");
    await firstChunk;
    socket.destroy();

    await withTimeout(upstreamSocketClosed, 500, "upstream response stream was not closed after downstream disconnect");
  });

  test("upstream abrupt abort emits overlapping response events but still closes downstream", async () => {
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("partial-body");
      setTimeout(() => res.socket?.destroy(), 10);
    });
    const upstreamPort = await listen(upstream);
    const port = await startGateway(
      makeConfig(),
      makeRouteSource({ demo: { slug: "demo", name: "Demo", hostAddress: "127.0.0.1", hostPort: upstreamPort } }),
    );

    const response = await withTimeout(rawHttp(port, "GET /abrupt HTTP/1.1\r\nHost: demo.lvh.me\r\nConnection: close\r\n\r\n"), 500, "downstream response hung");
    expect(response).toContain("200 OK");
    expect(response).toContain("partial-body");
  });

  test("premature fixed-content-length upstream close closes downstream without hanging", async () => {
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "content-length": "32", connection: "close" });
      res.write("partial-body");
      setTimeout(() => res.end(), 10);
    });
    const upstreamPort = await listen(upstream);
    const port = await startGateway(
      makeConfig(),
      makeRouteSource({ demo: { slug: "demo", name: "Demo", hostAddress: "127.0.0.1", hostPort: upstreamPort } }),
    );

    const response = await withTimeout(rawHttp(port, "GET /short HTTP/1.1\r\nHost: demo.lvh.me\r\nConnection: close\r\n\r\n"), 500, "downstream response hung");
    expect(response).toContain("200 OK");
    expect(response).toContain("content-length: 32");
    expect(response).toContain("partial-body");
    expect(response).not.toContain("partial-body".padEnd(32));
  });

  test("504 for upstream header-phase timeout", async () => {
    const upstream = createServer(() => {});
    const upstreamPort = await listen(upstream);
    const port = await startGateway(
      makeConfig({ upstreamTimeoutMs: 30 }),
      makeRouteSource({ demo: { slug: "demo", name: "Demo", hostAddress: "127.0.0.1", hostPort: upstreamPort } }),
    );
    const response = await fetch(`http://demo.lvh.me:${port}/`);
    expect(response.status).toBe(504);
  });

  test("client abort during async route lookup never opens an HTTP upstream connection", async () => {
    const lookup = deferred<AgentRoute | null>();
    const lookupStarted = deferred<void>();
    let upstreamConnections = 0;
    const upstream = createServer((_req, res) => {
      upstreamConnections += 1;
      res.end("unexpected");
    });
    upstream.on("connection", () => {
      upstreamConnections += 1;
    });
    const upstreamPort = await listen(upstream);
    const routeSource = makeRouteSource({});
    routeSource.lookup = async () => {
      lookupStarted.resolve();
      return lookup.promise;
    };
    const port = await startGateway(makeConfig(), routeSource);

    const client = connect(port, "127.0.0.1");
    sockets.add(client);
    await onceEvent(client, "connect");
    const clientClosed = onceAnyEvent(client, ["close", "error"]);
    client.write("POST /slow HTTP/1.1\r\nHost: demo.lvh.me\r\nContent-Length: 10\r\nConnection: close\r\n\r\n");
    await lookupStarted.promise;
    client.destroy();
    await clientClosed;
    await new Promise((resolve) => setImmediate(resolve));

    lookup.resolve({ slug: "demo", name: "Demo", hostAddress: "127.0.0.1", hostPort: upstreamPort });
    await new Promise((resolve) => setImmediate(resolve));

    expect(upstreamConnections).toBe(0);
  });

  test("rewrites loopback upstreams when configured", async () => {
    const route: AgentRoute = { slug: "demo", name: "Demo", hostAddress: "127.0.0.1", hostPort: 41000 };
    const { resolveUpstreamAddress } = await import("./app.js");
    expect(resolveUpstreamAddress(route, makeConfig({ upstreamHostOverride: "host.docker.internal" }))).toBe("host.docker.internal");
    expect(resolveUpstreamAddress({ ...route, hostAddress: "10.0.0.5" }, makeConfig({ upstreamHostOverride: "host.docker.internal" }))).toBe(
      "10.0.0.5",
    );
  });
});

function rawHttp(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let buffered = "";
    socket.on("data", (data) => {
      buffered += data.toString();
    });
    socket.on("close", () => resolve(buffered));
    socket.on("error", reject);
    socket.write(request);
  });
}

function waitForSocketData(socket: Socket, needle: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const onData = (data: Buffer) => {
      buffered += data.toString();
      if (buffered.includes(needle)) {
        cleanup();
        resolve(buffered);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`Socket closed before ${needle} was received`));
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

function onceEvent(stream: EventEmitter, event: string): Promise<void> {
  return new Promise((resolve) => stream.once(event, () => resolve()));
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

async function getUnusedPort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}
