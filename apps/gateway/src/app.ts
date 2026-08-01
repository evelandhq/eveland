import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";
import {
  AGENT_AUTH_ENVELOPE_HEADER,
  decodeAgentAuthEnvelope,
  type AgentAuthEnvelope,
} from "@eveland/core/agent-auth";
import { createConfigurationSnapshot } from "@eveland/core/config-diagnostics";
import {
  DEFAULT_API_SESSION_IDLE_TTL_MS,
  DEFAULT_PLAYGROUND_SESSION_IDLE_TTL_MS,
} from "@eveland/core/routing";
import type { ResolvedAgentRoute } from "@eveland/core/contracts";
import {
  classifyEveSessionRequest,
  isEveSessionNamespace,
  PLAYGROUND_MAX_TRANSPORT_BYTES,
} from "@eveland/core/eve";
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
  applyGatewaySessionResponse,
  resolveGatewaySessionBinding,
} from "./gateway-session-lifecycle.js";
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
  // Every hostname under an allowed base domain is cacheable, including ones
  // that resolve to no route, so an unbounded Map grows for as long as someone
  // sends requests with fresh subdomains. Expired entries are dropped first;
  // insertion order then evicts the oldest.
  const routeCacheMaxEntries = options.routeCacheMaxEntries ?? 1_000;
  const cacheRoute = (hostname: string, route: ResolvedAgentRoute | null) => {
    if (routeCache.size >= routeCacheMaxEntries) {
      const evictedAt = Date.now();
      for (const [key, entry] of routeCache) {
        if (entry.expiresAt <= evictedAt) routeCache.delete(key);
      }
      while (routeCache.size >= routeCacheMaxEntries) {
        const oldest = routeCache.keys().next();
        if (oldest.done) break;
        routeCache.delete(oldest.value);
      }
    }
    routeCache.set(hostname, { route, expiresAt: Date.now() + routeCacheTtlMs });
  };
  const maxRequestBodyBytes = options.maxRequestBodyBytes ?? 10_485_760;
  const now = options.now ?? (() => new Date());
  const sessionIdlePolicy = {
    playgroundIdleTtlMs:
      options.playgroundSessionIdleTtlMs ??
      Number(
        process.env.EVELAND_PLAYGROUND_SESSION_IDLE_TTL_MS ??
          DEFAULT_PLAYGROUND_SESSION_IDLE_TTL_MS,
      ),
    apiIdleTtlMs:
      options.apiSessionIdleTtlMs ??
      Number(
        process.env.EVELAND_API_SESSION_IDLE_TTL_MS ??
          DEFAULT_API_SESSION_IDLE_TTL_MS,
      ),
  };

  app.get("/health", (context) => context.json({ ok: true, ...buildInfo }));
  // Structural gate on the privileged surface: every /internal/* path is
  // service-authenticated here, before any handler, so a future internal
  // route cannot forget the check -- and an unregistered internal path can
  // never fall through to the public proxy catch-all.
  app.use("/internal/*", async (context, next) => {
    if (!isInternalRequest(context.req.header("authorization"), options.internalServiceToken)) {
      return context.json({ error: "Not found" }, 404);
    }
    await next();
  });

  app.get("/internal/diagnostics/config", (context) => {
    return context.json(configurationSnapshot);
  });
  app.all("/internal/projects/:projectId/playground/eve/*", async (context) => {
    let agentAuth: AgentAuthEnvelope;
    try {
      agentAuth = readAgentAuthEnvelope(context.req.header(AGENT_AUTH_ENVELOPE_HEADER));
    } catch {
      return context.json({ error: "Invalid Agent Auth envelope" }, 400);
    }

    const requestUrl = new URL(context.req.url);
    const playgroundPrefix = `/internal/projects/${encodeURIComponent(context.req.param("projectId"))}/playground`;
    const evePath = requestUrl.pathname.slice(playgroundPrefix.length);
    const eveRequest = classifyEveSessionRequest(context.req.method, evePath);
    if (!eveRequest) {
      return context.json({ error: "Not found" }, 404);
    }

    const route = await repository.findProjectRoute(context.req.param("projectId"));
    if (!route?.enabled) return context.json({ error: "Project route not found" }, 404);
    const declaredContentLength = Number(context.req.header("content-length"));
    if (Number.isFinite(declaredContentLength) && declaredContentLength > PLAYGROUND_MAX_TRANSPORT_BYTES) {
      return context.json({ error: "Request body too large" }, 413);
    }
    let routingBody: Uint8Array | null | undefined;
    if (eveRequest.kind === "initial" || eveRequest.kind === "reset") {
      try {
        routingBody = requestHasBody(context.req.method)
          ? await readLimitedBody(
              context.req.raw.body,
              PLAYGROUND_MAX_TRANSPORT_BYTES,
              context.req.raw.signal,
            )
          : null;
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          return context.json({ error: "Request body too large" }, 413);
        }
        if (
          error instanceof DownstreamAbortedError ||
          context.req.raw.signal.aborted
        ) {
          return new Response(JSON.stringify({ error: "Client closed request" }), {
            status: 499,
            headers: { "content-type": "application/json" },
          });
        }
        throw error;
      }
    }
    const session = await resolveGatewaySessionBinding({
      repository,
      projectId: route.projectId,
      request: eveRequest,
      bufferedBody: routingBody,
      now,
      idlePolicy: sessionIdlePolicy,
    });
    if (session.state === "unbound" && session.lookup === "session_id") {
      return context.json({ error: "Playground session not found" }, 404);
    }
    if (session.state === "expired") return sessionExpiredResponse();
    const binding = session.state === "active" ? session.binding : null;
    const activationOwnerId = crypto.randomUUID();
    const target = await resolveTarget(repository, route, binding, crypto.randomUUID(), Boolean(options.activationClient));
    if (!target) return context.json({ error: "No running deployment target" }, 503);
    const versionFailure = await unsupportedDeploymentResponse(repository, target.deploymentId);
    if (versionFailure) return versionFailure;
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
      const body = routingBody !== undefined
        ? routingBody
        : requestHasBody(context.req.method)
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

    try {
      await applyGatewaySessionResponse({
        repository,
        projectId: route.projectId,
        request: eveRequest,
        binding,
        upstream,
        target: {
          routeId: route.id,
          deploymentId: target.deploymentId,
          variantName: target.variantName,
          experimentId: routeExperimentId(route),
        },
        provenance: {
          kind: "playground",
          requestId: crypto.randomUUID(),
        },
      });
    } catch (error) {
      await cancelUpstreamAndReleaseActivation(
        upstream,
        error,
        activation,
        options.activationClient,
      );
      throw error;
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
  app.post("/internal/cache/invalidate", async (context) => {
    const input = (await context.req.json().catch(() => ({}))) as { hostname?: unknown };
    if (typeof input.hostname === "string") routeCache.delete(hostnameFromAuthority(canonicalAuthority(input.hostname)));
    else routeCache.clear();
    return context.json({ invalidated: true });
  });

  // Terminal boundary: an authenticated request for an internal path no
  // handler claims ends here, not in the public proxy catch-all.
  app.all("/internal/*", (context) => context.json({ error: "Not found" }, 404));

  app.all("*", async (context) => {
    const authority = canonicalAuthority(context.req.header("host") ?? new URL(context.req.url).host);
    const hostname = hostnameFromAuthority(authority);
    if (!isAllowedHostname(hostname, options.allowedBaseDomains)) return context.json({ error: "Route not found" }, 404);

    const cached = routeCache.get(hostname);
    const route = cached && cached.expiresAt > Date.now() ? cached.route : await repository.findRouteByHostname(hostname);
    if (!cached || cached.expiresAt <= Date.now()) cacheRoute(hostname, route);
    if (!route?.enabled) return context.json({ error: "Route not found" }, 404);

    const requestUrl = new URL(context.req.url);
    const eveRequest = classifyEveSessionRequest(context.req.method, requestUrl.pathname);
    if (!eveRequest && isEveSessionNamespace(requestUrl.pathname)) {
      return context.json({ error: "Route not found" }, 404);
    }
    const requestId = crypto.randomUUID();
    const remoteIp = remoteAddress(context);
    const affinity = affinityKey(context.req.raw.headers, options.affinitySecret);
    const declaredContentLength = Number(context.req.header("content-length"));
    if (Number.isFinite(declaredContentLength) && declaredContentLength > maxRequestBodyBytes) {
      return context.json({ error: "Request body too large" }, 413);
    }
    let routingBody: Uint8Array | null | undefined;
    if (eveRequest?.kind === "initial" || eveRequest?.kind === "reset") {
      try {
        routingBody = requestHasBody(context.req.method)
          ? await readLimitedBody(
              context.req.raw.body,
              maxRequestBodyBytes,
              context.req.raw.signal,
            )
          : null;
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          return context.json({ error: "Request body too large" }, 413);
        }
        if (
          error instanceof DownstreamAbortedError ||
          context.req.raw.signal.aborted
        ) {
          return new Response(JSON.stringify({ error: "Client closed request" }), {
            status: 499,
            headers: { "content-type": "application/json" },
          });
        }
        throw error;
      }
    }
    const session = await resolveGatewaySessionBinding({
      repository,
      projectId: route.projectId,
      request: eveRequest,
      bufferedBody: routingBody,
      now,
      idlePolicy: sessionIdlePolicy,
    });
    if (session.state === "expired") return sessionExpiredResponse();
    const binding = session.state === "active" ? session.binding : null;
    const target = await resolveTarget(repository, route, binding, affinity.key, Boolean(options.activationClient));
    if (!target) return context.json({ error: "No running deployment target" }, 503);
    if (eveRequest) {
      const versionFailure = await unsupportedDeploymentResponse(repository, target.deploymentId);
      if (versionFailure) return versionFailure;
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
      const body = routingBody !== undefined
        ? routingBody
        : requestHasBody(context.req.method)
          ? await readLimitedBody(context.req.raw.body, maxRequestBodyBytes, context.req.raw.signal)
          : null;
      upstream = await proxyToDeployment({
        port: activation?.endpointPort ?? target.hostPort,
        path: `${requestUrl.pathname}${requestUrl.search}`,
        method: context.req.method,
        headers: buildUpstreamHeaders(context.req.raw.headers, authority, requestUrl.protocol, requestId, remoteIp),
        body,
        signal: context.req.raw.signal,
        // Socket idle timeout, not a total deadline: streaming NDJSON keeps
        // resetting it, so a long turn is unaffected while a wedged deployment
        // that accepts the connection and never answers stops holding the
        // client, the socket, and its renewing activation lease forever.
        timeoutMs: options.upstreamTimeoutMs ?? Number(process.env.EVELAND_GATEWAY_UPSTREAM_TIMEOUT_MS ?? 120_000),
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

    try {
      await applyGatewaySessionResponse({
        repository,
        projectId: route.projectId,
        request: eveRequest,
        binding,
        upstream,
        target: {
          routeId: route.id,
          deploymentId: target.deploymentId,
          variantName: target.variantName,
          experimentId: routeExperimentId(route),
        },
        provenance: {
          kind: "api",
          requestId,
          remoteIp,
          affinity: {
            fingerprint: affinity.fingerprint,
            source: affinity.source,
          },
        },
      });
    } catch (error) {
      await cancelUpstreamAndReleaseActivation(
        upstream,
        error,
        activation,
        options.activationClient,
      );
      throw error;
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

function sessionExpiredResponse(): Response {
  return Response.json(
    { error: "Session expired", code: "session_expired" },
    { status: 410 },
  );
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

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isInternalRequest(authorization: string | undefined, token: string | undefined): boolean {
  if (!token || !authorization) return false;
  // Sole gate on the privileged /internal/* surface -- compare in constant
  // time, matching the affinity-cookie verification.
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  const provided = createHash("sha256").update(authorization).digest();
  return timingSafeEqual(expected, provided);
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
  const request = classifyEveSessionRequest(method, pathname);
  if (request?.kind === "stream") return "stream";
  if (request) return "turn";
  return "public_request";
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function cancelUpstreamAndReleaseActivation(
  upstream: Response,
  error: unknown,
  activation: { leaseId: string } | null,
  client: GatewayActivationClient | undefined,
): Promise<void> {
  await upstream.body?.cancel(error).catch(() => undefined);
  if (activation && client) {
    await client.release(activation.leaseId).catch(() => undefined);
  }
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
