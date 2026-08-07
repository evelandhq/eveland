import type { AgentAuthProviderRegistration, AgentCredentialContext } from "@evelandhq/agent-auth";
import { encodeAgentAuthEnvelope } from "@evelandhq/core/agent-auth";
import {
  classifyEveSessionRequest,
  getEveString,
  isEveRecord,
  PLAYGROUND_MAX_TRANSPORT_BYTES,
  validatePlaygroundTurn,
} from "@evelandhq/core/eve";
import { unsupportedEveVersionMessage } from "@evelandhq/core/source";
import type { ProjectStore, RoutingStore, SessionStore } from "@evelandhq/db";
import type { AgentAuthService } from "./agent-auth-service.js";
import {
  agentAuthFailureStatus,
  currentUserId,
  currentUserProfile,
  monitorPlaygroundStream,
  parsePlaygroundBody,
  parsePlaygroundResponse,
  readLimitedPlaygroundBody,
  resolveProjectEveVersion,
  type EveVersionStore,
} from "./app-support.js";
import type { ApiApp } from "./app-types.js";
import type { PlaygroundProxy } from "./gateway-playground.js";

export type CanonicalPlaygroundStore = EveVersionStore &
  Pick<ProjectStore, "getProject"> &
  Pick<RoutingStore, "findSessionBindingByContinuationToken"> &
  Pick<SessionStore, "completeSession" | "createSession" | "getSessionByEveSessionId">;

export function registerCanonicalPlaygroundRoute(input: {
  app: ApiApp;
  store: CanonicalPlaygroundStore;
  agentAuth: AgentAuthService;
  playgroundProxy: PlaygroundProxy;
}): void {
  const { app, store, agentAuth, playgroundProxy } = input;

  app.all("/projects/:projectId/playground/eve/*", async (c) => {
    const projectId = c.req.param("projectId");
    const requestUrl = new URL(c.req.url);
    const playgroundMarker = "/playground";
    const markerIndex = requestUrl.pathname.indexOf(playgroundMarker);
    const evePath =
      markerIndex >= 0 ? requestUrl.pathname.slice(markerIndex + playgroundMarker.length) : "";
    const eveRequest = classifyEveSessionRequest(c.req.method, evePath);
    if (!eveRequest) {
      return c.json({ error: "Playground route not found" }, 404);
    }
    const pathSessionId = eveRequest.sessionId;
    const isInitial = eveRequest.kind === "initial";
    const isContinuation = eveRequest.kind === "continuation";
    const isCancel = eveRequest.kind === "cancel";
    const isStream = eveRequest.kind === "stream";
    const isReset = eveRequest.kind === "reset";
    const isSessionControl =
      isCancel || isReset || eveRequest.kind === "clear" || eveRequest.kind === "compact";

    const project = await store.getProject(projectId);
    if (!project) return c.json({ error: "Project not found" }, 404);
    let agentAuthEnvelope: string;
    let activeProvider: AgentAuthProviderRegistration;
    let activeContext: AgentCredentialContext;
    let credentialVersion: unknown;
    try {
      const resolved = await agentAuth.resolveProjectAgentAuthCredential(
        projectId,
        currentUserId(c),
        currentUserProfile(c),
      );
      if ("failure" in resolved.resolution) {
        return c.json(
          resolved.resolution.failure,
          agentAuthFailureStatus(resolved.resolution.failure),
        );
      }
      activeProvider = resolved.provider;
      activeContext = resolved.context;
      credentialVersion = resolved.resolution.version;
      agentAuthEnvelope = encodeAgentAuthEnvelope(resolved.resolution.envelope);
    } catch (error) {
      return c.json(
        {
          error: "Playground authentication is not ready",
          detail:
            error instanceof Error
              ? error.message
              : "Invalid Playground authentication configuration.",
        },
        409,
      );
    }

    let body: Uint8Array | null = null;
    let resetContinuationToken: string | null = null;
    if (isInitial || isContinuation || isSessionControl) {
      try {
        body = await readLimitedPlaygroundBody(c.req.raw, PLAYGROUND_MAX_TRANSPORT_BYTES);
        if (isReset && !pathSessionId) {
          // Eve 0.29/0.30 generation: reset addresses the session through a
          // continuation token in the body. Eve 0.31 resets carry the session
          // in the path and need no token.
          const resetBody = parsePlaygroundBody(body);
          resetContinuationToken = isEveRecord(resetBody)
            ? getEveString(resetBody, "continuationToken")
            : null;
          if (!resetContinuationToken) {
            throw new Error("Playground reset requires a continuationToken.");
          }
        } else if (isInitial || isContinuation) {
          validatePlaygroundTurn(parsePlaygroundBody(body));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid Playground request";
        const status = message === "Playground request body is too large." ? 413 : 400;
        return c.json({ error: message }, status);
      }
    }

    const resetBinding = resetContinuationToken
      ? await store.findSessionBindingByContinuationToken(projectId, resetContinuationToken)
      : null;
    let platformSession = pathSessionId
      ? await store.getSessionByEveSessionId(projectId, pathSessionId)
      : resetBinding
        ? await store.getSessionByEveSessionId(projectId, resetBinding.eveSessionId)
        : null;
    if (pathSessionId && !platformSession) {
      return c.json({ error: "Playground session not found" }, 404);
    }
    const eveVersion = platformSession?.deploymentId
      ? await resolveProjectEveVersion(store, projectId, platformSession.deploymentId)
      : null;
    if (eveVersion && !eveVersion.supported) {
      return c.json(
        {
          error: "Unsupported Eve version",
          detail: unsupportedEveVersionMessage(eveVersion.version),
          eveVersion,
        },
        409,
      );
    }

    if (isInitial) {
      platformSession = await store.createSession({
        projectId,
        deploymentId: null,
        trigger: "playground",
      });
    }
    const failActiveTurn = async () => {
      if (platformSession && (isInitial || isContinuation)) {
        await store.completeSession(platformSession.id, {
          status: "failed",
          eveSessionId: pathSessionId,
        });
      }
    };

    // An Eve 0.29/0.30 deployment has no ID-addressed reset route; the stored
    // continuation token is both the proof of that generation and the value its
    // tokenless reset needs. Translating here lets the 0.31-shaped Playground
    // client reset sessions on every supported deployment.
    const legacyResetToken =
      isReset && pathSessionId ? (platformSession?.continuationToken ?? null) : null;
    const proxyPath = legacyResetToken
      ? `/eve/v1/session/reset${requestUrl.search}`
      : `${evePath}${requestUrl.search}`;
    let proxyBody = body;
    let proxyHeaders = c.req.raw.headers;
    if (legacyResetToken) {
      proxyBody = new TextEncoder().encode(JSON.stringify({ continuationToken: legacyResetToken }));
      proxyHeaders = new Headers(c.req.raw.headers);
      proxyHeaders.set("content-type", "application/json");
      proxyHeaders.delete("content-length");
    }

    let upstream: Response;
    try {
      const proxy = (envelope: string) =>
        playgroundProxy({
          projectId,
          path: proxyPath,
          method: c.req.method,
          headers: proxyHeaders,
          body: proxyBody,
          signal: c.req.raw.signal,
          agentAuthEnvelope: envelope,
        });
      upstream = await proxy(agentAuthEnvelope);
      if (
        upstream.status === 401 &&
        activeProvider.recoverUnauthorized &&
        credentialVersion !== undefined
      ) {
        await upstream.body?.cancel().catch(() => undefined);
        const recovery = await activeProvider.recoverUnauthorized({
          ...activeContext,
          rejectedVersion: credentialVersion,
          attempt: 0,
        });
        if (recovery.action === "give_up") {
          await failActiveTurn();
          return c.json(recovery.failure, agentAuthFailureStatus(recovery.failure));
        }
        const current = await agentAuth.resolveCurrentAgentAuthCredential(
          activeContext.connection.id,
          activeProvider.method,
          currentUserId(c),
          `/projects/${projectId}/playground`,
        );
        if (!current) {
          await failActiveTurn();
          return c.json(
            {
              error: "Playground authentication changed; retry the request.",
            },
            409,
          );
        }
        const retryContext = current.context;
        const retryCredential = current.resolution;
        if ("failure" in retryCredential) {
          await failActiveTurn();
          return c.json(retryCredential.failure, agentAuthFailureStatus(retryCredential.failure));
        }
        upstream = await proxy(encodeAgentAuthEnvelope(retryCredential.envelope));
        if (upstream.status === 401) {
          await upstream.body?.cancel().catch(() => undefined);
          const terminal = await activeProvider.recoverUnauthorized({
            ...retryContext,
            rejectedVersion: retryCredential.version,
            attempt: 1,
          });
          const failure =
            terminal.action === "give_up"
              ? terminal.failure
              : {
                  code: "retry_required" as const,
                  method: activeProvider.method,
                  message: "The Agent credential was rejected twice; retry the request.",
                };
          await failActiveTurn();
          return c.json(failure, agentAuthFailureStatus(failure));
        }
      }
    } catch (error) {
      await failActiveTurn();
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: "Playground request failed", detail: message }, 502);
    }

    if (!upstream.ok && platformSession && (isInitial || isContinuation)) {
      await failActiveTurn();
    }

    if ((isInitial || isContinuation) && upstream.ok && platformSession) {
      const parsed = await parsePlaygroundResponse(upstream.clone());
      const eveSessionId =
        upstream.headers.get("x-eve-session-id") ??
        getEveString(parsed, "sessionId") ??
        pathSessionId;
      await store.completeSession(platformSession.id, {
        status: "running",
        eveSessionId,
        continuationToken: getEveString(parsed, "continuationToken"),
      });
    }
    if (isReset && upstream.ok && platformSession) {
      const parsed = await parsePlaygroundResponse(upstream.clone());
      if (
        getEveString(parsed, "status") === "reset" &&
        getEveString(parsed, "previousSessionId") === platformSession.eveSessionId
      ) {
        await store.completeSession(platformSession.id, {
          status: "completed",
          eveSessionId: platformSession.eveSessionId,
          continuationToken: null,
        });
      }
    }

    const responseBody =
      isStream && upstream.ok && upstream.body && platformSession && pathSessionId
        ? monitorPlaygroundStream(upstream.body, store, platformSession.id, pathSessionId)
        : upstream.body;
    return new Response(responseBody, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  });
}
