import { maxHeaderSize, type IncomingMessage } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { resolveUpstreamAddress } from "./app.js";
import type { GatewayConfig } from "./config.js";
import { buildForwardHeaders } from "./headers.js";
import { classifyHost } from "./host.js";
import type { AgentRoute } from "./route-source.js";

const HEADER_DELIMITER = Buffer.from("\r\n\r\n");

// Node's default HTTP parser limit is 16 KiB. Keeping the raw upstream
// handshake buffer at the same ceiling bounds memory while still accepting any
// handshake Node itself would normally parse.
export const UPSTREAM_WEBSOCKET_HANDSHAKE_HEADER_LIMIT_BYTES = maxHeaderSize;

export function handleUpgrade(deps: {
  config: GatewayConfig;
  resolveRoute: (slug: string) => Promise<AgentRoute | null>;
}): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  return (req, socket, head) => {
    void (async () => {
      const closed = trackSocketClosed(socket);
      const classification = classifyHost(req.headers.host, deps.config.agentDomain);
      if (classification.kind !== "agent") {
        closed.cleanup();
        rejectSocket(socket, 404, "Unknown agent domain");
        return;
      }

      let route: AgentRoute | null;
      try {
        route = await deps.resolveRoute(classification.slug);
      } catch {
        if (closed.isClosed()) {
          socket.destroy();
          return;
        }
        closed.cleanup();
        rejectSocket(socket, 503, "Routing unavailable");
        return;
      }
      if (closed.isClosed()) {
        socket.destroy();
        return;
      }
      closed.cleanup();
      if (!route) {
        rejectSocket(socket, 404, "Unknown agent domain");
        return;
      }

      proxyUpgrade(req, socket, head, route, deps.config);
    })();
  };
}

function trackSocketClosed(socket: Duplex): { isClosed: () => boolean; cleanup: () => void } {
  let closed = socket.destroyed;
  const markClosed = () => {
    closed = true;
  };
  socket.once("close", markClosed);
  socket.once("error", markClosed);
  // An upgrade socket is detached from the HTTP parser, so nothing else
  // reacts to 'end': a client that sends FIN during route lookup would
  // otherwise stay half-open forever and look alive. Pre-handshake, a
  // half-closed client cannot complete a websocket handshake anyway.
  socket.once("end", markClosed);
  return {
    isClosed: () => closed || socket.destroyed,
    cleanup() {
      socket.off("close", markClosed);
      socket.off("error", markClosed);
      socket.off("end", markClosed);
    },
  };
}

function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, route: AgentRoute, config: GatewayConfig): void {
  let state: "handshaking" | "upgraded" | "rejecting" | "closed" = "handshaking";
  let buffered = Buffer.alloc(0);

  const upstream = connect(route.hostPort, resolveUpstreamAddress(route, config), () => {
    if (state !== "handshaking") {
      return;
    }
    const headers = buildForwardHeaders({
      requestHeaders: req.headers,
      clientAddress: req.socket.remoteAddress ?? "unknown",
      originalHost: req.headers.host ?? "",
    });
    headers.connection = "Upgrade";
    headers.upgrade = req.headers.upgrade;

    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue;
      for (const single of Array.isArray(value) ? value : [String(value)]) {
        lines.push(`${name}: ${single}`);
      }
    }
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head.length > 0) {
      upstream.write(head);
    }
    socket.pipe(upstream);
  });

  const handshakeTimer = setTimeout(() => {
    if (state !== "handshaking") {
      return;
    }
    rejectDuringHandshake("Upstream timed out before websocket handshake");
  }, config.upstreamTimeoutMs);

  const onHandshakeData = (chunk: Buffer | string) => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (state === "upgraded") {
      socket.write(data);
      return;
    }
    if (state !== "handshaking") {
      return;
    }

    const headerEnd = findHeaderDelimiter(buffered, data);
    if (headerEnd === -1) {
      if (buffered.length + data.length >= UPSTREAM_WEBSOCKET_HANDSHAKE_HEADER_LIMIT_BYTES) {
        rejectDuringHandshake("Upstream websocket handshake failed");
        return;
      }
      buffered = Buffer.concat([buffered, data]);
      return;
    }

    buffered = Buffer.concat([buffered, data]);
    const headerBlock = buffered.subarray(0, headerEnd).toString("latin1");
    if (!/^HTTP\/1\.1 101(?:\s|$)/i.test(headerBlock)) {
      rejectDuringHandshake("Upstream websocket handshake failed");
      return;
    }

    state = "upgraded";
    clearTimeout(handshakeTimer);
    upstream.off("data", onHandshakeData);
    socket.write(buffered);
    buffered = Buffer.alloc(0);
    upstream.pipe(socket);
  };

  upstream.on("data", onHandshakeData);

  upstream.on("error", () => {
    clearTimeout(handshakeTimer);
    if (state === "upgraded") {
      socket.destroy();
      return;
    }
    if (state === "handshaking") {
      rejectDuringHandshake("Upstream request failed");
    }
  });

  upstream.on("close", () => {
    clearTimeout(handshakeTimer);
    if (state === "upgraded") {
      socket.destroy();
      return;
    }
    if (state === "handshaking") {
      rejectDuringHandshake("Upstream request failed");
    }
  });

  socket.on("error", () => {
    clearTimeout(handshakeTimer);
    state = "closed";
    upstream.destroy();
  });
  socket.on("close", () => {
    clearTimeout(handshakeTimer);
    state = "closed";
    upstream.destroy();
  });

  function rejectDuringHandshake(message: string): void {
    if (state !== "handshaking") {
      return;
    }
    state = "rejecting";
    clearTimeout(handshakeTimer);
    rejectSocket(socket, 502, message);
    upstream.destroy();
  }
}

function findHeaderDelimiter(buffered: Buffer, data: Buffer): number {
  const remaining = UPSTREAM_WEBSOCKET_HANDSHAKE_HEADER_LIMIT_BYTES - buffered.length;
  if (remaining <= 0) {
    return -1;
  }
  const scanData = data.length <= remaining ? data : data.subarray(0, remaining);
  return Buffer.concat([buffered, scanData]).indexOf(HEADER_DELIMITER);
}

function rejectSocket(socket: Duplex, status: number, message: string): void {
  const reason = { 404: "Not Found", 502: "Bad Gateway", 503: "Service Unavailable" }[status] ?? "Error";
  const body = JSON.stringify({ error: message });
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(
      body,
    )}\r\nconnection: close\r\n\r\n${body}`,
  );
}
