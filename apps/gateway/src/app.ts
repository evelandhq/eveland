import http from "node:http";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { DeploymentRecord, ResolvedAgentRoute, SessionBinding as GatewaySessionBinding } from "@eveland/core/contracts";
import { selectWeightedTarget } from "@eveland/core/routing";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono } from "hono";

export type { ResolvedAgentRoute } from "@eveland/core/contracts";

export type GatewayRepository = {
  findRouteByHostname(hostname: string): Promise<ResolvedAgentRoute | null>;
  findProjectRoute(projectId: string): Promise<ResolvedAgentRoute | null>;
  getDeployment(deploymentId: string): Promise<DeploymentRecord | null>;
  findSessionBinding(projectId: string, eveSessionId: string): Promise<GatewaySessionBinding | null>;
  bindSession(input: Omit<GatewaySessionBinding, "id" | "createdAt" | "updatedAt">): Promise<unknown>;
};

export type GatewayAppOptions = {
  allowedBaseDomains: string[];
  internalServiceToken?: string;
  routeCacheTtlMs?: number;
};

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function createGatewayApp(repository: GatewayRepository, options: GatewayAppOptions): Hono {
  const app = new Hono();
  const routeCache = new Map<string, { route: ResolvedAgentRoute | null; expiresAt: number }>();
  const routeCacheTtlMs = options.routeCacheTtlMs ?? 5_000;

  app.get("/health", (context) => context.json({ ok: true, service: "eveland-gateway" }));
  app.post("/internal/projects/:projectId/playground", async (context) => {
    if (!isInternalRequest(context.req.header("authorization"), options.internalServiceToken)) {
      return context.json({ error: "Not found" }, 404);
    }
    const input = (await context.req.json().catch(() => null)) as { message?: unknown } | null;
    if (!input || typeof input.message !== "string" || input.message.length === 0) {
      return context.json({ error: "Invalid Playground message" }, 400);
    }
    const route = await repository.findProjectRoute(context.req.param("projectId"));
    if (!route?.enabled) return context.json({ error: "Project route not found" }, 404);
    const target = await resolveTarget(repository, route, null, crypto.randomUUID());
    if (!target) return context.json({ error: "No running deployment target" }, 503);

    const authority = `localhost:${target.hostPort}`;
    const startBody = JSON.stringify({ message: input.message });
    const startResponse = await proxyToDeployment({
      port: target.hostPort,
      path: "/eve/v1/session",
      method: "POST",
      headers: new Headers({ host: authority, "content-type": "application/json" }),
      body: new Blob([startBody]).stream(),
      timeoutMs: Number(process.env.EVELAND_PLAYGROUND_TIMEOUT_MS ?? 120_000),
    });
    const startText = await startResponse.text();
    if (!startResponse.ok) return context.json({ error: "Deployment rejected Playground request", detail: startText }, 502);
    const startValue = parseJsonRecord(startText);
    const eveSessionId =
      startResponse.headers.get("x-eve-session-id") ?? stringValue(startValue?.sessionId) ?? stringValue(startValue?.session_id);
    const continuationToken = stringValue(startValue?.continuationToken) ?? stringValue(startValue?.continuation_token);
    if (!eveSessionId) {
      return context.json({
        response: stringValue(startValue?.response) ?? stringValue(startValue?.message) ?? startText,
        eveSessionId: null,
        continuationToken,
        events: [],
      });
    }

    const requestId = crypto.randomUUID();
    await repository.bindSession({
      projectId: route.projectId,
      eveSessionId,
      routeId: route.id,
      deploymentId: target.deploymentId,
      trigger: "playground",
      variantName: target.variantName,
      requestId,
      remoteIp: null,
      affinityFingerprint: null,
    });
    const streamResponse = await proxyToDeployment({
      port: target.hostPort,
      path: `/eve/v1/session/${encodeURIComponent(eveSessionId)}/stream`,
      method: "GET",
      headers: new Headers({ host: authority, accept: "application/x-ndjson" }),
      body: null,
      timeoutMs: Number(process.env.EVELAND_PLAYGROUND_TIMEOUT_MS ?? 120_000),
    });
    if (!streamResponse.ok || !streamResponse.body) {
      return context.json({ error: "Deployment Playground stream failed" }, 502);
    }
    const streamed = await readPlaygroundStream(streamResponse.body, eveSessionId);
    return context.json({ ...streamed, eveSessionId, continuationToken });
  });
  app.post("/internal/cache/invalidate", async (context) => {
    if (!isInternalRequest(context.req.header("authorization"), options.internalServiceToken)) {
      return context.json({ error: "Not found" }, 404);
    }
    const input = (await context.req.json().catch(() => ({}))) as { hostname?: unknown };
    if (typeof input.hostname === "string") routeCache.delete(hostnameFromAuthority(canonicalAuthority(input.hostname)));
    else routeCache.clear();
    return context.json({ invalidated: true });
  });

  app.all("*", async (context) => {
    const authority = canonicalAuthority(context.req.header("host") ?? new URL(context.req.url).host);
    const hostname = hostnameFromAuthority(authority);
    if (!isAllowedHostname(hostname, options.allowedBaseDomains)) return context.json({ error: "Route not found" }, 404);

    const cached = routeCache.get(hostname);
    const route = cached && cached.expiresAt > Date.now() ? cached.route : await repository.findRouteByHostname(hostname);
    if (!cached || cached.expiresAt <= Date.now()) routeCache.set(hostname, { route, expiresAt: Date.now() + routeCacheTtlMs });
    if (!route?.enabled) return context.json({ error: "Route not found" }, 404);

    const requestUrl = new URL(context.req.url);
    const pathSessionId = sessionIdFromPath(requestUrl.pathname);
    const requestId = crypto.randomUUID();
    const remoteIp = remoteAddress(context);
    const affinity = affinityKey(context.req.raw.headers, remoteIp, requestId);
    const binding = pathSessionId ? await repository.findSessionBinding(route.projectId, pathSessionId) : null;
    const target = await resolveTarget(repository, route, binding, affinity.key);
    if (!target) return context.json({ error: "No running deployment target" }, 503);
    const upstream = await proxyToDeployment({
      port: target.hostPort,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      method: context.req.method,
      headers: buildUpstreamHeaders(context.req.raw.headers, authority, requestUrl.protocol, requestId, remoteIp),
      body: requestHasBody(context.req.method) ? context.req.raw.body : null,
    });

    if (context.req.method === "POST" && requestUrl.pathname === "/eve/v1/session" && upstream.ok) {
      const eveSessionId = upstream.headers.get("x-eve-session-id") ?? (await sessionIdFromJson(upstream.clone()));
      if (eveSessionId) {
        await repository.bindSession({
          projectId: route.projectId,
          eveSessionId,
          routeId: route.id,
          deploymentId: target.deploymentId,
          trigger: "api",
          variantName: target.variantName,
          requestId,
          remoteIp,
        affinityFingerprint: affinity.fingerprint,
        });
      }
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  });

  return app;
}

async function readPlaygroundStream(
  body: ReadableStream<Uint8Array>,
  eveSessionId: string,
): Promise<{
  response: string;
  status: "waiting" | "completed" | "failed";
  events: Array<{ type: string; payload: unknown; source: { eveSessionId: string; agentId: null; agentName: null } }>;
}> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ type: string; payload: unknown; source: { eveSessionId: string; agentId: null; agentName: null } }> = [];
  let buffer = "";
  let completedMessage = "";
  let partialMessage = "";
  let terminal = false;
  let status: "waiting" | "completed" | "failed" = "waiting";
  try {
    while (!terminal) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const event = parseJsonRecord(line);
        if (!event) continue;
        const type = stringValue(event.type) ?? "event";
        const payload = isRecord(event.data) ? event.data : event;
        if (type === "message.appended") partialMessage = stringValue(payload.messageSoFar) ?? partialMessage;
        if (type === "message.completed") {
          completedMessage =
            stringValue(payload.message) ?? stringValue(payload.text) ?? stringValue(payload.content) ?? partialMessage;
        }
        if (type !== "message.appended" && type !== "reasoning.appended") {
          events.push({ type, payload, source: { eveSessionId, agentId: null, agentName: null } });
        }
        terminal = playgroundTerminalTypes.has(type);
        if (type === "session.completed") status = "completed";
        else if (type === "session.failed" || type === "session.errored" || type === "turn.failed") status = "failed";
        if (terminal) break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const response = completedMessage || partialMessage;
  if (!response) throw new Error("Eve Playground session produced no response.");
  return { response, status, events };
}

const playgroundTerminalTypes = new Set([
  "turn.completed",
  "session.waiting",
  "session.completed",
  "session.failed",
  "session.errored",
  "turn.failed",
]);

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isInternalRequest(authorization: string | undefined, token: string | undefined): boolean {
  return Boolean(token && authorization === `Bearer ${token}`);
}

function proxyToDeployment(input: {
  port: number;
  path: string;
  method: string;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  timeoutMs?: number;
}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: input.port,
        path: input.path,
        method: input.method,
        headers: Object.fromEntries(input.headers.entries()),
      },
      (response) => {
        const headers = new Headers();
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          const name = response.rawHeaders[index];
          const value = response.rawHeaders[index + 1];
          if (name && value !== undefined && !hopByHopHeaders.has(name.toLowerCase())) headers.append(name, value);
        }
        resolve(
          new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
            status: response.statusCode ?? 502,
            statusText: response.statusMessage,
            headers,
          }),
        );
      },
    );
    request.once("error", reject);
    if (input.timeoutMs) request.setTimeout(input.timeoutMs, () => request.destroy(new Error("Upstream request timed out.")));
    if (input.body) {
      void pipeWebBody(input.body, request).catch((error) => {
        request.destroy(error instanceof Error ? error : new Error(String(error)));
        reject(error);
      });
    } else {
      request.end();
    }
  });
}

async function pipeWebBody(body: ReadableStream<Uint8Array>, request: http.ClientRequest): Promise<void> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!request.write(value)) await new Promise<void>((resolve) => request.once("drain", resolve));
    }
    request.end();
  } finally {
    reader.releaseLock();
  }
}

async function resolveTarget(
  repository: GatewayRepository,
  route: ResolvedAgentRoute,
  binding: GatewaySessionBinding | null,
  affinityKey: string,
): Promise<ResolvedAgentRoute["targets"][number] | null> {
  if (binding) {
    const routed = route.targets.find(
      (target) => target.deploymentId === binding.deploymentId && (target.status === "running" || target.status === "draining"),
    );
    if (routed) return routed;
    const deployment = await repository.getDeployment(binding.deploymentId);
    if (deployment && (deployment.status === "running" || deployment.status === "draining")) {
      return {
        routeId: route.id,
        deploymentId: deployment.id,
        weight: 0,
        variantName: binding.variantName,
        hostPort: deployment.hostPort,
        status: deployment.status,
      };
    }
    return null;
  }
  const eligible = route.targets.filter((target) => target.status === "running");
  if (eligible.length === 0) return null;
  return selectWeightedTarget(eligible, affinityKey);
}

function affinityKey(headers: Headers, remoteIp: string | null, requestId: string): { key: string; fingerprint: string } {
  const cookie = headers.get("cookie")?.match(/(?:^|;\s*)eveland_affinity=([^;]+)/)?.[1];
  const key = cookie ? decodeURIComponent(cookie) : `${remoteIp ?? "unknown"}|${headers.get("user-agent") ?? "unknown"}|${requestId}`;
  return { key, fingerprint: `sha256-${createHash("sha256").update(key).digest("hex")}` };
}

function buildUpstreamHeaders(
  input: Headers,
  authority: string,
  protocol: string,
  requestId: string,
  remoteIp: string | null,
): Headers {
  const headers = new Headers();
  for (const [name, value] of input) {
    const lower = name.toLowerCase();
    if (
      lower === "host" ||
      hopByHopHeaders.has(lower) ||
      lower === "forwarded" ||
      lower.startsWith("x-forwarded-") ||
      lower.startsWith("x-eveland-")
    ) {
      continue;
    }
    headers.append(name, value);
  }
  const proto = protocol === "https:" ? "https" : "http";
  headers.set("host", authority);
  const forwardedFor = remoteIp ?? "unknown";
  headers.set("forwarded", `for=${quoteForwarded(forwardedFor)};proto=${proto};host=${quoteForwarded(authority)}`);
  headers.set("x-forwarded-for", forwardedFor);
  headers.set("x-forwarded-host", authority);
  headers.set("x-forwarded-proto", proto);
  headers.set("x-eveland-request-id", requestId);
  return headers;
}

function remoteAddress(context: Parameters<typeof getConnInfo>[0]): string | null {
  try {
    return getConnInfo(context).remote.address ?? null;
  } catch {
    return null;
  }
}

function canonicalAuthority(value: string): string {
  return value.trim().toLowerCase();
}

function hostnameFromAuthority(authority: string): string {
  if (authority.startsWith("[")) return authority.slice(1, authority.indexOf("]"));
  return authority.split(":", 1)[0] ?? "";
}

function isAllowedHostname(hostname: string, domains: string[]): boolean {
  return domains.some((domain) => {
    const normalized = domain.toLowerCase().replace(/^\.+|\.+$/g, "");
    return hostname.endsWith(`.${normalized}`) && hostname.length > normalized.length + 1;
  });
}

function requestHasBody(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

function sessionIdFromPath(pathname: string): string | null {
  const match = /^\/eve\/v1\/session\/([^/]+)(?:\/|$)/.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

async function sessionIdFromJson(response: Response): Promise<string | null> {
  if (!response.headers.get("content-type")?.includes("application/json")) return null;
  const value = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const candidate = value?.sessionId ?? value?.session_id;
  return typeof candidate === "string" ? candidate : null;
}

function quoteForwarded(value: string): string {
  return `"${value.replace(/["\\]/g, "")}"`;
}
