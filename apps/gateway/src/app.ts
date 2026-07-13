import http from "node:http";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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
  affinitySecret: string;
  internalServiceToken?: string;
  routeCacheTtlMs?: number;
  maxRequestBodyBytes?: number;
  affinityCookieSecure?: boolean;
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
  if (!options.affinitySecret) throw new Error("Gateway affinity secret is required.");
  if (
    options.maxRequestBodyBytes !== undefined &&
    (!Number.isSafeInteger(options.maxRequestBodyBytes) || options.maxRequestBodyBytes < 0)
  ) {
    throw new Error("Gateway request body limit must be a non-negative safe integer.");
  }
  const app = new Hono();
  const routeCache = new Map<string, { route: ResolvedAgentRoute | null; expiresAt: number }>();
  const routeCacheTtlMs = options.routeCacheTtlMs ?? 5_000;
  const maxRequestBodyBytes = options.maxRequestBodyBytes ?? 10_485_760;

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
      body: new TextEncoder().encode(startBody),
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
      affinitySource: null,
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
    const affinity = affinityKey(context.req.raw.headers, options.affinitySecret);
    const binding = pathSessionId ? await repository.findSessionBinding(route.projectId, pathSessionId) : null;
    const target = await resolveTarget(repository, route, binding, affinity.key);
    if (!target) return context.json({ error: "No running deployment target" }, 503);
    let upstream: Response;
    try {
      const contentLength = Number(context.req.header("content-length"));
      if (Number.isFinite(contentLength) && contentLength > maxRequestBodyBytes) throw new RequestBodyTooLargeError();
      const body = requestHasBody(context.req.method)
        ? await readLimitedBody(context.req.raw.body, maxRequestBodyBytes, context.req.raw.signal)
        : null;
      upstream = await proxyToDeployment({
        port: target.hostPort,
        path: `${requestUrl.pathname}${requestUrl.search}`,
        method: context.req.method,
        headers: buildUpstreamHeaders(context.req.raw.headers, authority, requestUrl.protocol, requestId, remoteIp),
        body,
        signal: context.req.raw.signal,
      });
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) return context.json({ error: "Request body too large" }, 413);
      if (error instanceof DownstreamAbortedError) {
        return new Response(JSON.stringify({ error: "Client closed request" }), {
          status: 499,
          headers: { "content-type": "application/json" },
        });
      }
      throw error;
    }

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
          affinitySource: affinity.source,
        });
      }
    }

    const responseHeaders = new Headers(upstream.headers);
    if (affinity.cookieValue) {
      responseHeaders.append(
        "set-cookie",
        serializeAffinityCookie(
          affinity.cookieValue,
          matchingBaseDomain(hostname, options.allowedBaseDomains),
          options.affinityCookieSecure ?? requestUrl.protocol === "https:",
        ),
      );
    }
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
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
  body: Uint8Array | null;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<Response> {
  return new Promise((resolve, reject) => {
    let responseStarted = false;
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: input.port,
        path: input.path,
        method: input.method,
        headers: Object.fromEntries(input.headers.entries()),
      },
      (response) => {
        responseStarted = true;
        const headers = new Headers();
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          const name = response.rawHeaders[index];
          const value = response.rawHeaders[index + 1];
          if (name && value !== undefined && !hopByHopHeaders.has(name.toLowerCase())) headers.append(name, value);
        }
        resolve(
          new Response(proxyResponseBody(response, request), {
            status: response.statusCode ?? 502,
            statusText: response.statusMessage,
            headers,
          }),
        );
      },
    );
    const abort = () => request.destroy(new DownstreamAbortedError());
    const cleanup = () => input.signal?.removeEventListener("abort", abort);
    request.once("error", (error) => {
      cleanup();
      if (!responseStarted) reject(error);
    });
    request.once("close", cleanup);
    if (input.signal?.aborted) abort();
    else input.signal?.addEventListener("abort", abort, { once: true });
    if (input.timeoutMs) request.setTimeout(input.timeoutMs, () => request.destroy(new Error("Upstream request timed out.")));
    request.end(input.body ?? undefined);
  });
}

async function readLimitedBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new DownstreamAbortedError();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("request body limit exceeded").catch(() => undefined);
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function proxyResponseBody(response: http.IncomingMessage, request: http.ClientRequest): ReadableStream<Uint8Array> {
  const body = Readable.toWeb(response) as ReadableStream<Uint8Array>;
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      response.destroy();
      request.destroy();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
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
  return selectWeightedTarget(eligible, affinityKey, { id: route.id, policyRevision: route.policyRevision });
}

function affinityKey(
  headers: Headers,
  secret: string,
): {
  key: string;
  fingerprint: string;
  source: "cookie" | "version_key" | "generated";
  cookieValue: string | null;
} {
  const cookie = headers.get("cookie")?.match(/(?:^|;\s*)eveland_affinity=([^;]+)/)?.[1];
  const decodedCookie = cookie ? safeDecodeURIComponent(cookie) : null;
  const verifiedCookie = decodedCookie ? verifyAffinityCookie(decodedCookie, secret) : null;
  if (verifiedCookie) return affinityResult(verifiedCookie, "cookie", null);

  const versionKey = headers.get("x-eveland-version-key")?.trim();
  if (versionKey) return affinityResult(versionKey, "version_key", null);

  const key = randomBytes(32).toString("base64url");
  return affinityResult(key, "generated", signAffinityCookie(key, secret));
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function affinityResult(
  key: string,
  source: "cookie" | "version_key" | "generated",
  cookieValue: string | null,
) {
  return { key, source, cookieValue, fingerprint: `sha256-${createHash("sha256").update(key).digest("hex")}` };
}

function signAffinityCookie(key: string, secret: string): string {
  return `${key}.${createHmac("sha256", secret).update(key).digest("base64url")}`;
}

function verifyAffinityCookie(value: string, secret: string): string | null {
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return null;
  const key = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expected = createHmac("sha256", secret).update(key).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? key : null;
}

function serializeAffinityCookie(value: string, domain: string, secure: boolean): string {
  return `eveland_affinity=${encodeURIComponent(value)}; Domain=${domain}; Path=/; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax`;
}

function matchingBaseDomain(hostname: string, domains: string[]): string {
  return domains
    .map((domain) => domain.toLowerCase().replace(/^\.+|\.+$/g, ""))
    .find((domain) => hostname.endsWith(`.${domain}`))!;
}

class RequestBodyTooLargeError extends Error {}

class DownstreamAbortedError extends Error {
  constructor() {
    super("Downstream request aborted.");
  }
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
    if (lower === "cookie") {
      const cookie = value
        .split(";")
        .map((part) => part.trim())
        .filter((part) => !part.startsWith("eveland_affinity="))
        .join("; ");
      if (cookie) headers.append(name, cookie);
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
