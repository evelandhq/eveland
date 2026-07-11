import { createServer, type Server } from "node:http";
import type { EventEmitter } from "node:events";
import { connect } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { createGatewayServer } from "./app.js";
import type { GatewayConfig } from "./config.js";
import type { AgentRoute, RouteSource } from "./route-source.js";
import { UPSTREAM_WEBSOCKET_HANDSHAKE_HEADER_LIMIT_BYTES } from "./upgrade.js";

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

describe("gateway websocket upgrades", () => {
  test("websocket upgrade preserves bytes received with the 101 response exactly once", async () => {
    const upstream = createServer(() => {});
    upstream.on("upgrade", (_req, socket) => {
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nearly-frame");
    });
    const upstreamPort = await listen(upstream);
    const port = await startGateway(
      makeConfig(),
      makeRouteSource({ demo: { slug: "demo", name: "Demo", hostAddress: "127.0.0.1", hostPort: upstreamPort } }),
    );

    const response = await rawUpgradeUntil(port, "demo.lvh.me", (buffered, socket) => {
      const headerEnd = buffered.indexOf("\r\n\r\n");
      if (headerEnd === -1 || !buffered.slice(headerEnd + 4).includes("early-frame")) {
        return;
      }
      setTimeout(() => socket.destroy(), 20);
    });
    const payload = response.slice(response.indexOf("\r\n\r\n") + 4);
    expect(response).toContain("101 Switching Protocols");
    expect(payload).toBe("early-frame");
  });

  test("websocket upgrade is piped raw in both directions without duplicate frames", async () => {
    const upstream = createServer(() => {});
    upstream.on("upgrade", (_req, socket) => {
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
      socket.on("data", (data) => socket.write(data));
    });
    const upstreamPort = await listen(upstream);
    const port = await startGateway(
      makeConfig(),
      makeRouteSource({ demo: { slug: "demo", name: "Demo", hostAddress: "127.0.0.1", hostPort: upstreamPort } }),
    );

    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1");
      let buffered = "";
      let upgraded = false;
      let resolveTimer: NodeJS.Timeout | undefined;
      socket.on("data", (data) => {
        buffered += data.toString();
        if (!upgraded && buffered.includes("\r\n\r\n")) {
          expect(buffered).toContain("101 Switching Protocols");
          upgraded = true;
          buffered = buffered.slice(buffered.indexOf("\r\n\r\n") + 4);
          socket.write("ping-frame");
          return;
        }
        if (upgraded && buffered.includes("ping-frame")) {
          resolveTimer ??= setTimeout(() => {
            socket.destroy();
            resolve(buffered);
          }, 20);
        }
      });
      socket.on("error", reject);
      socket.write(
        "GET /ws HTTP/1.1\r\nHost: demo.lvh.me\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n\r\n",
      );
    });
    expect(response).toBe("ping-frame");
    expect(countOccurrences(response, "ping-frame")).toBe(1);
  });

  test("upgrade for an unknown slug answers 404 and closes", async () => {
    const port = await startGateway(makeConfig(), makeRouteSource({}));
    const response = await rawUpgrade(port, "ghost.lvh.me");
    expect(response).toContain("404");
  });

  test("partial no-delimiter upstream handshake close answers a complete 502 exactly once and cleans up upstream", async () => {
    let upstreamSocketCleanedUp!: Promise<void>;
    const upstream = createServer(() => {});
    upstream.on("upgrade", (_req, socket) => {
      upstreamSocketCleanedUp = onceAnyEvent(socket, ["end", "close"]);
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket");
      setTimeout(() => socket.end(), 10);
    });
    const upstreamPort = await listen(upstream);
    const port = await startGateway(
      makeConfig(),
      makeRouteSource({ demo: { slug: "demo", name: "Demo", hostAddress: "127.0.0.1", hostPort: upstreamPort } }),
    );
    const response = await rawUpgrade(port, "demo.lvh.me");
    expectRawJsonError(response, 502, "Bad Gateway", "Upstream request failed");
    await withTimeout(upstreamSocketCleanedUp, 500, "upstream socket was not cleaned up after partial handshake close");
  });

  test("ECONNREFUSED before websocket handshake answers a complete 502 exactly once", async () => {
    const unusedPort = await getUnusedPort();
    const port = await startGateway(
      makeConfig({ upstreamTimeoutMs: 200 }),
      makeRouteSource({ demo: { slug: "demo", name: "Demo", hostAddress: "127.0.0.1", hostPort: unusedPort } }),
    );
    const response = await rawUpgrade(port, "demo.lvh.me");
    expectRawJsonError(response, 502, "Bad Gateway", "Upstream request failed");
  });

  test("upstream non-101 websocket response answers a complete 502 exactly once", async () => {
    const upstream = createServer(() => {});
    upstream.on("upgrade", (_req, socket) => {
      socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
    const upstreamPort = await listen(upstream);
    const port = await startGateway(
      makeConfig(),
      makeRouteSource({ demo: { slug: "demo", name: "Demo", hostAddress: "127.0.0.1", hostPort: upstreamPort } }),
    );
    const response = await rawUpgrade(port, "demo.lvh.me");
    expectRawJsonError(response, 502, "Bad Gateway", "Upstream websocket handshake failed");
  });

  test("pre-handshake upstream timeout answers a complete 502 exactly once", async () => {
    const upstream = createServer(() => {});
    upstream.on("upgrade", () => {});
    const upstreamPort = await listen(upstream);
    const port = await startGateway(
      makeConfig({ upstreamTimeoutMs: 30 }),
      makeRouteSource({ demo: { slug: "demo", name: "Demo", hostAddress: "127.0.0.1", hostPort: upstreamPort } }),
    );
    const response = await rawUpgrade(port, "demo.lvh.me");
    expectRawJsonError(response, 502, "Bad Gateway", "Upstream timed out before websocket handshake");
  });

  test("oversized websocket handshake without delimiter answers a complete 502 exactly once and closes upstream", async () => {
    let upstreamSocketCleanedUp!: Promise<void>;
    const upstream = createServer(() => {});
    upstream.on("upgrade", (_req, socket) => {
      upstreamSocketCleanedUp = onceAnyEvent(socket, ["end", "close"]);
      const firstChunk = Math.floor(UPSTREAM_WEBSOCKET_HANDSHAKE_HEADER_LIMIT_BYTES / 2);
      const secondChunk = UPSTREAM_WEBSOCKET_HANDSHAKE_HEADER_LIMIT_BYTES - firstChunk - 1;
      socket.write(Buffer.alloc(firstChunk, "a"));
      setTimeout(() => {
        socket.write(Buffer.alloc(secondChunk, "b"));
        setTimeout(() => {
          socket.write(Buffer.alloc(2, "c"));
        }, 20);
      }, 20);
    });
    const upstreamPort = await listen(upstream);
    const port = await startGateway(
      makeConfig(),
      makeRouteSource({ demo: { slug: "demo", name: "Demo", hostAddress: "127.0.0.1", hostPort: upstreamPort } }),
    );

    const response = await rawUpgrade(port, "demo.lvh.me");
    expectRawJsonError(response, 502, "Bad Gateway", "Upstream websocket handshake failed");
    await withTimeout(upstreamSocketCleanedUp, 500, "upstream socket was not cleaned up after oversized handshake");
  });

  test("post-handshake upstream errors do not write HTTP errors into the upgraded stream", async () => {
    const upstream = createServer(() => {});
    upstream.on("upgrade", (_req, socket) => {
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nfirst-frame");
      setTimeout(() => socket.destroy(), 10);
    });
    const upstreamPort = await listen(upstream);
    const port = await startGateway(
      makeConfig(),
      makeRouteSource({ demo: { slug: "demo", name: "Demo", hostAddress: "127.0.0.1", hostPort: upstreamPort } }),
    );

    const response = await rawUpgrade(port, "demo.lvh.me");
    const payload = response.slice(response.indexOf("\r\n\r\n") + 4);
    expect(response).toContain("101 Switching Protocols");
    expect(payload).toBe("first-frame");
    expect(payload).not.toContain("HTTP/1.1");
    expect(payload).not.toContain("Bad Gateway");
  });
  test("client abort during async route lookup never opens a websocket upstream connection", async () => {
    const lookup = deferred<AgentRoute | null>();
    const lookupStarted = deferred<void>();
    let upstreamConnections = 0;
    const upstream = createServer(() => {});
    upstream.on("connection", () => {
      upstreamConnections += 1;
    });
    upstream.on("upgrade", (_req, socket) => {
      socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
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
    client.write("GET /ws HTTP/1.1\r\nHost: demo.lvh.me\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    await lookupStarted.promise;
    client.destroy();
    await clientClosed;
    await new Promise((resolve) => setImmediate(resolve));

    lookup.resolve({ slug: "demo", name: "Demo", hostAddress: "127.0.0.1", hostPort: upstreamPort });
    await new Promise((resolve) => setImmediate(resolve));

    expect(upstreamConnections).toBe(0);
  });
});

function rawUpgrade(port: number, host: string): Promise<string> {
  return rawUpgradeUntil(port, host);
}

function rawUpgradeUntil(port: number, host: string, onData?: (buffered: string, socket: Socket) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let buffered = "";
    socket.on("data", (data) => {
      buffered += data.toString();
      onData?.(buffered, socket);
    });
    socket.on("close", () => resolve(buffered));
    socket.on("error", reject);
    socket.write(`GET /ws HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
  });
}

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

function onceAnyEvent(stream: EventEmitter, events: string[]): Promise<void> {
  return new Promise((resolve) => {
    const cleanup = () => {
      for (const event of events) {
        stream.off(event, onEvent);
      }
    };
    const onEvent = () => {
      cleanup();
      resolve();
    };
    for (const event of events) {
      stream.once(event, onEvent);
    }
  });
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

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function expectRawJsonError(response: string, status: number, reason: string, message: string): void {
  const body = JSON.stringify({ error: message });
  const expected =
    `HTTP/1.1 ${status} ${reason}\r\n` +
    "content-type: application/json\r\n" +
    `content-length: ${Buffer.byteLength(body)}\r\n` +
    "connection: close\r\n" +
    "\r\n" +
    body;
  expect(response).toBe(expected);
  expect(countOccurrences(response, `HTTP/1.1 ${status} ${reason}`)).toBe(1);
  expect(countOccurrences(response, "content-type: application/json")).toBe(1);
  expect(countOccurrences(response, `content-length: ${Buffer.byteLength(body)}`)).toBe(1);
  expect(countOccurrences(response, "connection: close")).toBe(1);
  expect(countOccurrences(response, body)).toBe(1);
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
