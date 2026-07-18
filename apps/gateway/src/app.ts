import http from "node:http";
import { Readable } from "node:stream";
import {
  AGENT_AUTH_ENVELOPE_HEADER,
  decodeAgentAuthEnvelope,
  type AgentAuthEnvelope,
} from "@eveland/core/agent-auth";
import { createConfigurationSnapshot } from "@eveland/core/config-diagnostics";
import type { ResolvedAgentRoute } from "@eveland/core/contracts";
import { PLAYGROUND_MAX_TRANSPORT_BYTES } from "@eveland/core/eve";
import { createBuildInfoFromEnv } from "@eveland/core/server/build-info";
import {
  createEveVersionInfo,
  unsupportedEveVersionMessage,
} from "@eveland/core/source";
import { Hono } from "hono";

export type { ResolvedAgentRoute } from "@eveland/core/contracts";
export type { GatewayActivationClient, GatewayAppOptions, GatewayRepository } from "./gateway-types.js";
import type { GatewayActivationClient, GatewayAppOptions, GatewayRepository } from "./gateway-types.js";
import {
  DownstreamAbortedError,
  RequestBodyTooLargeError,
  affinityKey,
  buildInternalPlaygroundHeaders,
  buildUpstreamHeaders,
  canonicalAuthority,
  hostnameFromAuthority,
  isAllowedHostname,
  matchingBaseDomain,
  readAgentAuthEnvelope,
  remoteAddress,
  requestHasBody,
  resolveTarget,
  routeExperimentId,
  serializeAffinityCookie,
  sessionIdFromJson,
  sessionIdFromPath,
} from "./gateway-routing.js";

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
  const buildInfo = options.buildInfo ?? createBuildInfoFromEnv("gateway", process.env);
  const configurationSnapshot = options.configurationSnapshot ?? createConfigurationSnapshot("gateway", process.env);
  const routeCache = new Map<string, { route: ResolvedAgentRoute | null; expiresAt: number }>();
  const routeCacheTtlMs = options.routeCacheTtlMs ?? 5_000;
  const maxRequestBodyBytes = options.maxRequestBodyBytes ?? 10_485_760;

  app.get("/health", (context) => context.json({ ok: true, ...buildInfo }));
  app.get("/internal/diagnostics/config", (context) => {
    if (!isInternalRequest(context.req.header("authorization"), options.internalServiceToken)) {
      return context.json({ error: "Not found" }, 404);
    }
    return context.json(configurationSnapshot);
  });
  app.all("/internal/projects/:projectId/playground/eve/*", async (context) => {
    if (!isInternalRequest(context.req.header("authorization"), options.internalServiceToken)) {
      return context.json({ error: "Not found" }, 404);
    }
    let agentAuth: AgentAuthEnvelope;
    try {
      agentAuth = readAgentAuthEnvelope(context.req.header(AGENT_AUTH_ENVELOPE_HEADER));
    } catch {
      return context.json({ error: "Invalid Agent Auth envelope" }, 400);
    }

    const requestUrl = new URL(context.req.url);
    const playgroundPrefix = `/internal/projects/${encodeURIComponent(context.req.param("projectId"))}/playground`;
    const evePath = requestUrl.pathname.slice(playgroundPrefix.length);
    const pathSessionId = sessionIdFromPath(evePath);
    const isInitial = context.req.method === "POST" && evePath === "/eve/v1/session";
    const isContinuation = context.req.method === "POST" && /^\/eve\/v1\/session\/[^/]+$/.test(evePath);
    const isCancel = context.req.method === "POST" && /^\/eve\/v1\/session\/[^/]+\/cancel$/.test(evePath);
    const isStream = context.req.method === "GET" && /^\/eve\/v1\/session\/[^/]+\/stream$/.test(evePath);
    if (!isInitial && !isContinuation && !isCancel && !isStream) return context.json({ error: "Not found" }, 404);

    const route = await repository.findProjectRoute(context.req.param("projectId"));
    if (!route?.enabled) return context.json({ error: "Project route not found" }, 404);
    const binding = pathSessionId ? await repository.findSessionBinding(route.projectId, pathSessionId) : null;
    if (pathSessionId && !binding) return context.json({ error: "Playground session not found" }, 404);
    const activationOwnerId = crypto.randomUUID();
    const target = await resolveTarget(repository, route, binding, crypto.randomUUID(), Boolean(options.activationClient));
    if (!target) return context.json({ error: "No running deployment target" }, 503);
    const versionFailure = await unsupportedDeploymentResponse(repository, target.deploymentId);
    if (versionFailure) return versionFailure;
    const declaredContentLength = Number(context.req.header("content-length"));
    if (Number.isFinite(declaredContentLength) && declaredContentLength > PLAYGROUND_MAX_TRANSPORT_BYTES) {
      return context.json({ error: "Request body too large" }, 413);
    }
    let activation: { leaseId: string; endpointPort: number } | null = null;
    if (options.activationClient) {
      try {
        activation = await options.activationClient.activate({
          deploymentId: target.deploymentId,
          kind: activationKind(context.req.method, evePath),
          ownerId: activationOwnerId,
        }, context.req.raw.signal);
      } catch (error) {
        if (context.req.raw.signal.aborted || isAbortError(error)) {
          return new Response(JSON.stringify({ error: "Client closed request" }), {
            status: 499,
            headers: { "content-type": "application/json" },
          });
        }
        return context.json({ error: "Deployment activation failed" }, 503);
      }
    }

    let upstream: Response;
    try {
      const body = requestHasBody(context.req.method)
        ? await readLimitedBody(context.req.raw.body, PLAYGROUND_MAX_TRANSPORT_BYTES, context.req.raw.signal)
        : null;
      const endpointPort = activation?.endpointPort ?? target.hostPort;
      const authority = agentAuth.authority === "loopback" ? `localhost:${endpointPort}` : route.hostname;
      upstream = await proxyToDeployment({
        port: endpointPort,
        path: `${evePath}${requestUrl.search}`,
        method: context.req.method,
        headers: buildInternalPlaygroundHeaders(context.req.raw.headers, authority, agentAuth.headers),
        body,
        signal: context.req.raw.signal,
        timeoutMs: Number(process.env.EVELAND_PLAYGROUND_TIMEOUT_MS ?? 120_000),
      });
    } catch (error) {
      if (activation && options.activationClient) await options.activationClient.release(activation.leaseId).catch(() => undefined);
      if (error instanceof RequestBodyTooLargeError) return context.json({ error: "Request body too large" }, 413);
      if (error instanceof DownstreamAbortedError) {
        return new Response(JSON.stringify({ error: "Client closed request" }), {
          status: 499,
          headers: { "content-type": "application/json" },
        });
      }
      throw error;
    }

    if (isInitial && upstream.ok) {
      const eveSessionId = upstream.headers.get("x-eve-session-id") ?? (await sessionIdFromJson(upstream.clone()));
      if (eveSessionId) {
        try {
          await repository.bindSession({
            projectId: route.projectId,
            eveSessionId,
            routeId: route.id,
            deploymentId: target.deploymentId,
            trigger: "playground",
            variantName: target.variantName,
            experimentId: routeExperimentId(route),
            requestId: crypto.randomUUID(),
            remoteIp: null,
            affinityFingerprint: null,
            affinitySource: null,
          });
        } catch (error) {
          await upstream.body?.cancel(error).catch(() => undefined);
          if (activation && options.activationClient) {
            await options.activationClient.release(activation.leaseId).catch(() => undefined);
          }
          throw error;
        }
      }
    }

    const response = new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
    return activation && options.activationClient
      ? manageActivationResponse(response, options.activationClient, activation.leaseId, options.activationRenewIntervalMs ?? 60_000)
      : response;
  });
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
    const activationOwnerId = crypto.randomUUID();
    const target = await resolveTarget(repository, route, null, crypto.randomUUID(), Boolean(options.activationClient));
    if (!target) return context.json({ error: "No running deployment target" }, 503);
    const versionFailure = await unsupportedDeploymentResponse(repository, target.deploymentId);
    if (versionFailure) return versionFailure;

    let activation: { leaseId: string; endpointPort: number } | null = null;
    if (options.activationClient) {
      try {
        activation = await options.activationClient.activate({
          deploymentId: target.deploymentId,
          kind: "turn",
          ownerId: activationOwnerId,
        }, context.req.raw.signal);
      } catch (error) {
        if (context.req.raw.signal.aborted || isAbortError(error)) {
          return new Response(JSON.stringify({ error: "Client closed request" }), {
            status: 499,
            headers: { "content-type": "application/json" },
          });
        }
        return context.json({ error: "Deployment activation failed" }, 503);
      }
    }

    try {
      const authority = `localhost:${target.hostPort}`;
      const endpointPort = activation?.endpointPort ?? target.hostPort;
      const startBody = JSON.stringify({ message: input.message });
      const startResponse = await proxyToDeployment({
        port: endpointPort,
        path: "/eve/v1/session",
        method: "POST",
        headers: new Headers({ host: authority, "content-type": "application/json" }),
        body: new TextEncoder().encode(startBody),
        signal: context.req.raw.signal,
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
        experimentId: routeExperimentId(route),
        requestId,
        remoteIp: null,
        affinityFingerprint: null,
        affinitySource: null,
      });
      const streamResponse = await proxyToDeployment({
        port: endpointPort,
        path: `/eve/v1/session/${encodeURIComponent(eveSessionId)}/stream`,
        method: "GET",
        headers: new Headers({ host: authority, accept: "application/x-ndjson" }),
        body: null,
        signal: context.req.raw.signal,
        timeoutMs: Number(process.env.EVELAND_PLAYGROUND_TIMEOUT_MS ?? 120_000),
      });
      if (!streamResponse.ok || !streamResponse.body) {
        return context.json({ error: "Deployment Playground stream failed" }, 502);
      }
      const streamed = await readPlaygroundStream(streamResponse.body, eveSessionId);
      return context.json({ ...streamed, eveSessionId, continuationToken });
    } finally {
      if (activation && options.activationClient) {
        await options.activationClient.release(activation.leaseId).catch(() => undefined);
      }
    }
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
    const target = await resolveTarget(repository, route, binding, affinity.key, Boolean(options.activationClient));
    if (!target) return context.json({ error: "No running deployment target" }, 503);
    if (isEveSessionRequest(context.req.method, requestUrl.pathname)) {
      const versionFailure = await unsupportedDeploymentResponse(repository, target.deploymentId);
      if (versionFailure) return versionFailure;
    }
    const declaredContentLength = Number(context.req.header("content-length"));
    if (Number.isFinite(declaredContentLength) && declaredContentLength > maxRequestBodyBytes) {
      return context.json({ error: "Request body too large" }, 413);
    }
    let activation: { leaseId: string; endpointPort: number } | null = null;
    if (options.activationClient) {
      try {
        activation = await options.activationClient.activate({
          deploymentId: target.deploymentId,
          kind: activationKind(context.req.method, requestUrl.pathname),
          ownerId: requestId,
        }, context.req.raw.signal);
      } catch (error) {
        if (context.req.raw.signal.aborted || isAbortError(error)) {
          return new Response(JSON.stringify({ error: "Client closed request" }), {
            status: 499,
            headers: { "content-type": "application/json" },
          });
        }
        return context.json({ error: "Deployment activation failed" }, 503);
      }
    }
    let upstream: Response;
    try {
      const body = requestHasBody(context.req.method)
        ? await readLimitedBody(context.req.raw.body, maxRequestBodyBytes, context.req.raw.signal)
        : null;
      upstream = await proxyToDeployment({
        port: activation?.endpointPort ?? target.hostPort,
        path: `${requestUrl.pathname}${requestUrl.search}`,
        method: context.req.method,
        headers: buildUpstreamHeaders(context.req.raw.headers, authority, requestUrl.protocol, requestId, remoteIp),
        body,
        signal: context.req.raw.signal,
      });
    } catch (error) {
      if (activation && options.activationClient) await options.activationClient.release(activation.leaseId).catch(() => undefined);
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
        try {
          await repository.bindSession({
            projectId: route.projectId,
            eveSessionId,
            routeId: route.id,
            deploymentId: target.deploymentId,
            trigger: "api",
            variantName: target.variantName,
            experimentId: routeExperimentId(route),
            requestId,
            remoteIp,
            affinityFingerprint: affinity.fingerprint,
            affinitySource: affinity.source,
          });
        } catch (error) {
          await upstream.body?.cancel(error).catch(() => undefined);
          if (activation && options.activationClient) {
            await options.activationClient.release(activation.leaseId).catch(() => undefined);
          }
          throw error;
        }
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
    const response = new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
    return activation && options.activationClient
      ? manageActivationResponse(response, options.activationClient, activation.leaseId, options.activationRenewIntervalMs ?? 60_000)
      : response;
  });

  return app;
}

async function unsupportedDeploymentResponse(
  repository: GatewayRepository,
  deploymentId: string,
): Promise<Response | null> {
  const eveVersion = await repository.getDeploymentEveVersion(deploymentId) ?? createEveVersionInfo(null, null);
  if (eveVersion.supported) return null;
  return Response.json({
    error: "Unsupported Eve version",
    detail: unsupportedEveVersionMessage(eveVersion.version),
    eveVersion,
  }, { status: 409 });
}

function isEveSessionRequest(method: string, pathname: string): boolean {
  return (
    (method === "POST" && pathname === "/eve/v1/session") ||
    (method === "POST" && /^\/eve\/v1\/session\/[^/]+$/.test(pathname)) ||
    (method === "POST" && /^\/eve\/v1\/session\/[^/]+\/cancel$/.test(pathname)) ||
    (method === "GET" && /^\/eve\/v1\/session\/[^/]+\/stream$/.test(pathname))
  );
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

function activationKind(method: string, pathname: string): "public_request" | "stream" | "turn" {
  if (method === "GET" && /^\/eve\/v1\/session\/[^/]+\/stream$/.test(pathname)) return "stream";
  if (method === "POST" && /^\/eve\/v1\/session(?:\/[^/]+(?:\/cancel)?)?$/.test(pathname)) return "turn";
  return "public_request";
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function manageActivationResponse(
  response: Response,
  client: GatewayActivationClient,
  leaseId: string,
  renewIntervalMs: number,
): Response {
  if (!response.body) {
    void client.release(leaseId).catch(() => undefined);
    return response;
  }
  const reader = response.body.getReader();
  let finalized = false;
  const renewTimer = setInterval(() => {
    void client.renew(leaseId).catch(() => undefined);
  }, renewIntervalMs);
  renewTimer.unref?.();
  const finalize = async () => {
    if (finalized) return;
    finalized = true;
    clearInterval(renewTimer);
    await client.release(leaseId).catch(() => undefined);
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          await finalize();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        await finalize();
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      await finalize();
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
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
