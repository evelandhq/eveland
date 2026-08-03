import { createHash, timingSafeEqual } from "node:crypto";
import { AGENT_AUTH_ENVELOPE_HEADER, type AgentAuthEnvelope } from "@eveland/core/agent-auth";
import { createConfigurationSnapshot } from "@eveland/core/config-diagnostics";
import {
  DEFAULT_API_SESSION_IDLE_TTL_MS,
  DEFAULT_PLAYGROUND_SESSION_IDLE_TTL_MS,
} from "@eveland/core/routing";
import {
  classifyEveSessionRequest,
  isEveSessionNamespace,
  PLAYGROUND_MAX_TRANSPORT_BYTES,
} from "@eveland/core/eve";
import { createBuildInfoFromEnv } from "@eveland/core/server/build-info";
import { Hono } from "hono";

export type { ResolvedAgentRoute } from "@eveland/core/contracts";
export type {
  GatewayActivationClient,
  GatewayAppOptions,
  GatewayRepository,
} from "./gateway-types.js";
import type { GatewayAppOptions, GatewayRepository } from "./gateway-types.js";
import { resolveGatewaySessionBinding } from "./gateway-session-lifecycle.js";
import {
  executeGatewaySessionProxy,
  readRoutingBody,
  sessionExpiredResponse,
} from "./gateway-request-lifecycle.js";
import { createGatewayRouteCache } from "./gateway-route-cache.js";
import {
  affinityKey,
  buildInternalPlaygroundHeaders,
  buildUpstreamHeaders,
  canonicalAuthority,
  hostnameFromAuthority,
  isAllowedHostname,
  matchingBaseDomain,
  readAgentAuthEnvelope,
  remoteAddress,
  serializeAffinityCookie,
} from "./gateway-routing.js";

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
  const configurationSnapshot =
    options.configurationSnapshot ?? createConfigurationSnapshot("gateway", process.env);
  const routeCache = createGatewayRouteCache({
    ttlMs: options.routeCacheTtlMs ?? 5_000,
    maxEntries: options.routeCacheMaxEntries ?? 1_000,
  });
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
      Number(process.env.EVELAND_API_SESSION_IDLE_TTL_MS ?? DEFAULT_API_SESSION_IDLE_TTL_MS),
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
    const routingBody = await readRoutingBody({
      request: context.req.raw,
      eveRequest,
      limitBytes: PLAYGROUND_MAX_TRANSPORT_BYTES,
    });
    if (!routingBody.ok) return routingBody.response;
    const session = await resolveGatewaySessionBinding({
      repository,
      projectId: route.projectId,
      request: eveRequest,
      bufferedBody: routingBody.body,
      now,
      idlePolicy: sessionIdlePolicy,
    });
    // Unlike the public path, an unknown session_id is a client error here,
    // not something to proxy through.
    if (session.state === "unbound" && session.lookup === "session_id") {
      return context.json({ error: "Playground session not found" }, 404);
    }
    if (session.state === "expired") return sessionExpiredResponse();
    const binding = session.state === "active" ? session.binding : null;
    return executeGatewaySessionProxy({
      repository,
      activationClient: options.activationClient,
      activationRenewIntervalMs: options.activationRenewIntervalMs ?? 60_000,
      route,
      eveRequest,
      binding,
      targetKey: crypto.randomUUID(),
      activationOwnerId: crypto.randomUUID(),
      provenance: { kind: "playground", requestId: crypto.randomUUID() },
      request: context.req.raw,
      routingBody: routingBody.body,
      upstreamPath: `${evePath}${requestUrl.search}`,
      policy: {
        bodyLimitBytes: PLAYGROUND_MAX_TRANSPORT_BYTES,
        timeoutMs: Number(process.env.EVELAND_PLAYGROUND_TIMEOUT_MS ?? 120_000),
        buildHeaders: (endpointPort) =>
          buildInternalPlaygroundHeaders(
            context.req.raw.headers,
            agentAuth.authority === "loopback" ? `localhost:${endpointPort}` : route.hostname,
            agentAuth.headers,
          ),
      },
    });
  });
  app.post("/internal/cache/invalidate", async (context) => {
    const input = (await context.req.json().catch(() => ({}))) as { hostname?: unknown };
    if (typeof input.hostname === "string")
      routeCache.delete(hostnameFromAuthority(canonicalAuthority(input.hostname)));
    else routeCache.clear();
    return context.json({ invalidated: true });
  });

  // Terminal boundary: an authenticated request for an internal path no
  // handler claims ends here, not in the public proxy catch-all.
  app.all("/internal/*", (context) => context.json({ error: "Not found" }, 404));

  app.all("*", async (context) => {
    const authority = canonicalAuthority(
      context.req.header("host") ?? new URL(context.req.url).host,
    );
    const hostname = hostnameFromAuthority(authority);
    if (!isAllowedHostname(hostname, options.allowedBaseDomains))
      return context.json({ error: "Route not found" }, 404);

    const cached = routeCache.read(hostname);
    const route = cached !== undefined ? cached : await repository.findRouteByHostname(hostname);
    if (cached === undefined) routeCache.store(hostname, route);
    if (!route?.enabled) return context.json({ error: "Route not found" }, 404);

    const requestUrl = new URL(context.req.url);
    const eveRequest = classifyEveSessionRequest(context.req.method, requestUrl.pathname);
    if (!eveRequest && isEveSessionNamespace(requestUrl.pathname)) {
      return context.json({ error: "Route not found" }, 404);
    }
    const requestId = crypto.randomUUID();
    const remoteIp = remoteAddress(context);
    const affinity = affinityKey(context.req.raw.headers, options.affinitySecret);
    const routingBody = await readRoutingBody({
      request: context.req.raw,
      eveRequest,
      limitBytes: maxRequestBodyBytes,
    });
    if (!routingBody.ok) return routingBody.response;
    const session = await resolveGatewaySessionBinding({
      repository,
      projectId: route.projectId,
      request: eveRequest,
      bufferedBody: routingBody.body,
      now,
      idlePolicy: sessionIdlePolicy,
    });
    if (session.state === "expired") return sessionExpiredResponse();
    const binding = session.state === "active" ? session.binding : null;
    return executeGatewaySessionProxy({
      repository,
      activationClient: options.activationClient,
      activationRenewIntervalMs: options.activationRenewIntervalMs ?? 60_000,
      route,
      eveRequest,
      binding,
      targetKey: affinity.key,
      activationOwnerId: requestId,
      provenance: {
        kind: "api",
        requestId,
        remoteIp,
        affinity: {
          fingerprint: affinity.fingerprint,
          source: affinity.source,
        },
      },
      request: context.req.raw,
      routingBody: routingBody.body,
      upstreamPath: `${requestUrl.pathname}${requestUrl.search}`,
      policy: {
        bodyLimitBytes: maxRequestBodyBytes,
        // Socket idle timeout, not a total deadline: streaming NDJSON keeps
        // resetting it, so a long turn is unaffected while a wedged deployment
        // that accepts the connection and never answers stops holding the
        // client, the socket, and its renewing activation lease forever.
        timeoutMs:
          options.upstreamTimeoutMs ??
          Number(process.env.EVELAND_GATEWAY_UPSTREAM_TIMEOUT_MS ?? 120_000),
        buildHeaders: () =>
          buildUpstreamHeaders(
            context.req.raw.headers,
            authority,
            requestUrl.protocol,
            requestId,
            remoteIp,
          ),
        decorateResponseHeaders: (headers) => {
          if (affinity.cookieValue) {
            headers.append(
              "set-cookie",
              serializeAffinityCookie(
                affinity.cookieValue,
                matchingBaseDomain(hostname, options.allowedBaseDomains),
                options.affinityCookieSecure ?? requestUrl.protocol === "https:",
              ),
            );
          }
        },
      },
    });
  });

  return app;
}

function isInternalRequest(authorization: string | undefined, token: string | undefined): boolean {
  if (!token || !authorization) return false;
  // Sole gate on the privileged /internal/* surface -- compare in constant
  // time, matching the affinity-cookie verification.
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  const provided = createHash("sha256").update(authorization).digest();
  return timingSafeEqual(expected, provided);
}
