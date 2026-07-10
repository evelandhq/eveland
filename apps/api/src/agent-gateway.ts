import type { Context, Hono } from "hono";
import { projectIdFromShortId, projectShortId } from "@eveland/shared/ids";
import type { Store } from "./store.js";

// The public surface of an agent is the eve contract only: the /eve/v1 session
// API plus channel webhooks, and durable-workflow resume webhooks under
// /.well-known/workflow/. Anything else an agent serves stays box-private.
const publicPathPrefixes = ["/eve/", "/.well-known/workflow/"];

const hopByHopHeaders = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

// Bound the wait for the upstream to return response headers. A deployment that
// accepts the socket but never answers would otherwise pin gateway resources
// until Node's runtime defaults expire; the deadline is cleared once headers
// arrive so long-lived eve conversation streams are never cut off.
const DEFAULT_UPSTREAM_HEADER_TIMEOUT_MS = 15_000;

export interface AgentGatewayOptions {
  readonly upstreamHeaderTimeoutMs?: number;
}

/**
 * Public entrypoint for deployed agents: `/a/<shortId>/<agent path>` is
 * stream-proxied to the agent's deployment on `127.0.0.1:<hostPort>` with the
 * `/a/<shortId>` prefix stripped, so agents keep serving their fixed eve routes.
 */
export function registerAgentGateway(app: Hono, store: Store, options: AgentGatewayOptions = {}): void {
  const upstreamHeaderTimeoutMs = options.upstreamHeaderTimeoutMs ?? DEFAULT_UPSTREAM_HEADER_TIMEOUT_MS;
  // Public discovery document: lets clients list connectable agents without
  // access to the management API. Served with a wildcard CORS header because
  // it sits in front of the platform CORS middleware like the rest of /a/*.
  app.get("/.well-known/eve/agents.json", async (c) => {
    const origin = resolvePublicOrigin(c);
    const projects = await store.listProjects();
    const agents = projects
      .filter((project) => project.deploymentStatus === "running")
      .map((project) => {
        const shortId = projectShortId(project.id);
        return { id: shortId, name: project.name, url: `${origin}/a/${shortId}` };
      });
    return c.json({ agents }, 200, { "access-control-allow-origin": "*" });
  });

  app.all("/a/:shortId/*", async (c) => {
    const requestUrl = new URL(c.req.url);
    // Split on the raw pathname, not the decoded route param: a percent-encoded
    // short id would decode to a valid-looking value while the raw prefix has a
    // different length, misaligning the strip. The short id alphabet has no
    // characters that need encoding, so the raw segment is the canonical form.
    const [shortId, agentPath] = splitAgentPath(requestUrl.pathname);
    const projectId = projectIdFromShortId(shortId);
    if (!projectId) {
      return c.json({ error: "Unknown agent" }, 404);
    }

    if (!isPublicAgentPath(agentPath)) {
      return c.json({ error: "Not found" }, 404);
    }

    const project = await store.getProject(projectId);
    if (!project) {
      return c.json({ error: "Unknown agent" }, 404);
    }

    const deployment = await store.getCurrentDeployment(projectId);
    if (!deployment || deployment.status !== "running") {
      return c.json({ error: "Agent has no running deployment" }, 503);
    }

    const upstreamUrl = `http://127.0.0.1:${deployment.hostPort}${agentPath}${requestUrl.search}`;
    return proxyRequest(c, upstreamUrl, `/a/${shortId}`, upstreamHeaderTimeoutMs);
  });
}

function resolvePublicOrigin(c: Context): string {
  const configured = process.env.EVELAND_PUBLIC_ORIGIN?.trim().replace(/\/+$/, "");
  return configured || new URL(c.req.url).origin;
}

function splitAgentPath(pathname: string): [shortId: string, agentPath: string] {
  const rest = pathname.slice("/a/".length);
  const slashIndex = rest.indexOf("/");
  if (slashIndex === -1) {
    return [rest, "/"];
  }
  return [rest.slice(0, slashIndex), rest.slice(slashIndex)];
}

function isPublicAgentPath(pathname: string): boolean {
  if (!publicPathPrefixes.some((prefix) => pathname.startsWith(prefix))) {
    return false;
  }
  // An encoded separator survives URL parsing here but an upstream router may
  // decode `%2f`/`%5c` before matching and split the path on it, so a segment
  // like `%2e%2e%2fadmin` would normalize past the public prefix. eve routes
  // never contain encoded separators, so reject them outright.
  if (/%2f|%5c/i.test(pathname)) {
    return false;
  }
  // `..` in plain form is already normalized away by URL parsing, but a
  // percent-encoded dot segment survives it and would be re-normalized by the
  // upstream router into a path outside the public prefixes. Decode each
  // segment fully (a doubly-encoded `%252e` decodes to `.` in two passes)
  // before the dot-segment check.
  return pathname.split("/").every((segment) => {
    const decoded = fullyDecode(segment);
    return decoded !== "." && decoded !== "..";
  });
}

function fullyDecode(segment: string): string {
  let current = segment;
  for (let pass = 0; pass < 5; pass += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return current;
    }
    if (next === current) {
      return next;
    }
    current = next;
  }
  return current;
}

async function proxyRequest(c: Context, upstreamUrl: string, prefix: string, headerTimeoutMs: number): Promise<Response> {
  const requestUrl = new URL(c.req.url);
  const headers = new Headers(c.req.raw.headers);
  for (const name of hopByHopHeaders) {
    headers.delete(name);
  }
  headers.delete("host");
  // Identity keeps the upstream body byte-identical through the proxy, so
  // content-length/content-encoding response headers stay truthful.
  headers.set("accept-encoding", "identity");
  headers.set("x-forwarded-host", requestUrl.host);
  if (!headers.has("x-forwarded-proto")) {
    headers.set("x-forwarded-proto", requestUrl.protocol.replace(":", ""));
  }
  headers.set("x-forwarded-prefix", prefix);

  const method = c.req.method;
  const body = method === "GET" || method === "HEAD" ? undefined : c.req.raw.body;

  // Abort the upstream when the client disconnects, or when the header deadline
  // passes. The timer is cleared as soon as headers arrive so the deadline only
  // guards the connect/first-byte phase and not the streamed body.
  const headerDeadline = new AbortController();
  const timer = setTimeout(() => headerDeadline.abort(), headerTimeoutMs);
  const signal = AbortSignal.any([headerDeadline.signal, c.req.raw.signal]);

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method,
      headers,
      body,
      redirect: "manual",
      signal,
      // Node's fetch requires half-duplex to stream a request body.
      ...(body ? { duplex: "half" } : {}),
    } as RequestInit);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return c.json({ error: "Agent deployment is unreachable", detail }, 502);
  } finally {
    clearTimeout(timer);
  }

  const responseHeaders = new Headers(upstream.headers);
  for (const name of hopByHopHeaders) {
    responseHeaders.delete(name);
  }
  const location = responseHeaders.get("location");
  if (location?.startsWith("/")) {
    responseHeaders.set("location", `${prefix}${location}`);
  }

  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
