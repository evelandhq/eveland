import http from "node:http";
import type { GatewayConfig } from "./config.js";
import { buildForwardHeaders, filterUpstreamResponseHeaders } from "./headers.js";
import { handleDiscovery } from "./discovery.js";
import { classifyHost } from "./host.js";
import { createRouteCache } from "./route-cache.js";
import type { AgentRoute, RouteSource } from "./route-source.js";
import { handleUpgrade } from "./upgrade.js";

export function resolveUpstreamAddress(route: AgentRoute, config: GatewayConfig): string {
  const isLoopback = route.hostAddress === "127.0.0.1" || route.hostAddress === "::1" || route.hostAddress === "localhost";
  return config.upstreamHostOverride && isLoopback ? config.upstreamHostOverride : route.hostAddress;
}

export function createGatewayServer(deps: { config: GatewayConfig; routeSource: RouteSource }): http.Server {
  const { config, routeSource } = deps;
  const cache = createRouteCache({ ttlMs: config.routeTtlMs });

  void routeSource
    .subscribe({
      onInvalidate(slug) {
        if (slug === null) {
          cache.clear();
        } else {
          cache.invalidate(slug);
        }
      },
    })
    .catch((error) => {
      console.error("Gateway route subscription failed; serving with TTL-only cache invalidation.", error);
    });

  async function resolveRoute(slug: string): Promise<AgentRoute | null> {
    const cached = cache.get(slug);
    if (cached) {
      return cached.route;
    }
    const route = await routeSource.lookup(slug);
    cache.set(slug, route);
    return route;
  }

  const server = http.createServer(async (req, res) => {
    if (req.url === "/healthz" && req.method === "GET") {
      sendJson(res, 200, { ok: true, service: "eveland-gateway" });
      return;
    }

    const classification = classifyHost(req.headers.host, config.agentDomain);

    if (classification.kind === "apex") {
      if (req.method === "GET" && req.url?.split("?")[0] === "/.well-known/eve/agents.json") {
        await handleDiscovery(res, { routeSource, config });
        return;
      }
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    if (classification.kind === "unknown") {
      sendJson(res, 404, { error: "Unknown agent domain" });
      return;
    }

    const closed = trackRequestClosed(req, res);
    let route: AgentRoute | null;
    try {
      route = await resolveRoute(classification.slug);
    } catch (error) {
      await yieldToPendingCloseEvents();
      if (closed.isClosed()) {
        return;
      }
      closed.cleanup();
      console.error(`Route lookup failed for ${classification.slug}:`, error);
      sendJson(res, 503, { error: "Routing unavailable" });
      return;
    }

    await yieldToPendingCloseEvents();
    if (closed.isClosed()) {
      return;
    }
    closed.cleanup();

    if (!route) {
      sendJson(res, 404, { error: "Unknown agent domain" });
      return;
    }

    proxyRequest(req, res, route, config);
  });

  server.on("upgrade", handleUpgrade({ config, resolveRoute }));

  return server;
}

function yieldToPendingCloseEvents(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function trackRequestClosed(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): { isClosed: () => boolean; cleanup: () => void } {
  let closed = req.destroyed || res.destroyed || res.writableEnded;
  const markClosed = () => {
    closed = true;
  };
  req.socket.once("close", markClosed);
  req.once("aborted", markClosed);
  res.once("close", markClosed);
  return {
    isClosed: () => closed || req.destroyed || res.destroyed || res.writableEnded,
    cleanup() {
      req.socket.off("close", markClosed);
      req.off("aborted", markClosed);
      res.off("close", markClosed);
    },
  };
}

function proxyRequest(req: http.IncomingMessage, res: http.ServerResponse, route: AgentRoute, config: GatewayConfig): void {
  let upstreamResponse: http.IncomingMessage | null = null;
  let upstreamResponseEnded = false;
  let downstreamResponseFinished = false;

  const upstream = http.request({
    host: resolveUpstreamAddress(route, config),
    port: route.hostPort,
    method: req.method,
    path: req.url,
    headers: buildForwardHeaders({
      requestHeaders: req.headers,
      clientAddress: req.socket.remoteAddress ?? "unknown",
      originalHost: req.headers.host ?? "",
    }),
    setHost: false,
  });

  const headerTimer = setTimeout(() => {
    upstream.destroy(new HeaderTimeoutError());
  }, config.upstreamTimeoutMs);

  upstream.on("response", (responseFromUpstream) => {
    clearTimeout(headerTimer);
    upstreamResponse = responseFromUpstream;
    upstreamResponseEnded = false;
    responseFromUpstream.on("end", () => {
      upstreamResponseEnded = true;
    });
    responseFromUpstream.on("aborted", destroyDownstreamResponse);
    responseFromUpstream.on("error", destroyDownstreamResponse);
    responseFromUpstream.on("close", () => {
      if (!upstreamResponseEnded) {
        destroyDownstreamResponse();
      }
    });

    res.writeHead(responseFromUpstream.statusCode ?? 502, filterUpstreamResponseHeaders(responseFromUpstream.headers));
    responseFromUpstream.pipe(res);
  });

  upstream.on("error", (error: NodeJS.ErrnoException) => {
    clearTimeout(headerTimer);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error instanceof HeaderTimeoutError) {
      sendJson(res, 504, { error: "Upstream timed out before sending headers" });
      return;
    }
    if (error.code === "ECONNREFUSED") {
      sendJson(res, 503, { error: "Agent deployment is not accepting connections" });
      return;
    }
    sendJson(res, 502, { error: "Upstream request failed" });
  });

  req.on("aborted", () => {
    clearTimeout(headerTimer);
    destroyUpstream();
  });

  req.on("close", () => {
    if (!req.complete) {
      clearTimeout(headerTimer);
      destroyUpstream();
    }
  });

  res.on("finish", () => {
    downstreamResponseFinished = true;
    clearTimeout(headerTimer);
  });

  res.on("close", () => {
    if (!downstreamResponseFinished) {
      clearTimeout(headerTimer);
      destroyUpstream();
    }
  });

  req.pipe(upstream);

  function destroyUpstream(): void {
    upstream.destroy();
    upstreamResponse?.destroy();
  }

  function destroyDownstreamResponse(): void {
    if (!downstreamResponseFinished && !res.writableEnded) {
      res.destroy();
    }
  }
}

class HeaderTimeoutError extends Error {
  constructor() {
    super("Upstream header timeout");
    this.name = "HeaderTimeoutError";
  }
}

function sendJson(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
