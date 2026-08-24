import type { AgentAuthProviderRegistration, AgentCredentialContext } from "@evelandhq/agent-auth";
import { encodeAgentAuthEnvelope } from "@evelandhq/core/agent-auth";
import {
  classifyEveSessionRequest,
  getEveString,
  PLAYGROUND_MAX_TRANSPORT_BYTES,
  validatePlaygroundTurn,
} from "@evelandhq/core/eve";
import { unsupportedEveVersionMessage } from "@evelandhq/core/source";
import { CANONICAL_REQUEST_ID_HEADER } from "@evelandhq/core/workflow-dispatch";
import type { ProjectStore, SessionStore } from "@evelandhq/db";
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
  Pick<SessionStore, "completeSession" | "createSession" | "getSessionByEveSessionId">;

/**
 * Distills a non-ok upstream response into a stored failure reason. The body
 * is read from a clone so the original still flows back to the browser; a
 * gateway rejection's body carries the "why" — activation failure, no running
 * target, cold-start timeout — that previously existed only in host logs.
 */
async function upstreamRejectionReason(upstream: Response): Promise<string> {
  let detail = "";
  try {
    const text = (await upstream.clone().text()).trim();
    try {
      const parsed = JSON.parse(text) as { error?: unknown; detail?: unknown };
      detail = [parsed.error, parsed.detail]
        .filter((value): value is string => typeof value === "string")
        .join(": ");
    } catch {
      detail = text;
    }
  } catch {
    // The reason falls back to the bare status line.
  }
  detail = detail.slice(0, 500);
  return `The turn failed upstream with HTTP ${upstream.status}${detail ? `: ${detail}` : "."}`;
}

export function registerCanonicalPlaygroundRoute(input: {
  app: ApiApp;
  store: CanonicalPlaygroundStore;
  agentAuth: AgentAuthService;
  playgroundProxy: PlaygroundProxy;
}): void {
  const { app, store, agentAuth, playgroundProxy } = input;

  app.all("/projects/:projectId/playground/eve/*", async (c) => {
    const projectId = c.req.param("projectId");
    // One canonical id from the browser (when it sent one) through API,
    // Gateway, activation and dispatcher logs; echoed on every response so a
    // user-visible failure is correlatable without guessing.
    const requestId =
      c.req.header(CANONICAL_REQUEST_ID_HEADER)?.slice(0, 64) ?? crypto.randomUUID();
    c.header(CANONICAL_REQUEST_ID_HEADER, requestId);
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
    if (isInitial || isContinuation || isSessionControl) {
      try {
        body = await readLimitedPlaygroundBody(c.req.raw, PLAYGROUND_MAX_TRANSPORT_BYTES);
        if (isInitial || isContinuation) {
          validatePlaygroundTurn(parsePlaygroundBody(body));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid Playground request";
        const status = message === "Playground request body is too large." ? 413 : 400;
        return c.json({ error: message }, status);
      }
    }

    let platformSession = pathSessionId
      ? await store.getSessionByEveSessionId(projectId, pathSessionId)
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
    // Every path that flips the session to `failed` states why: without a
    // stored reason the session list shows a bare red badge and the detail
    // page renders nothing, leaving the operator to reconstruct the cause
    // from host logs and SQL (#294).
    const failActiveTurn = async (reason: string) => {
      if (platformSession && (isInitial || isContinuation)) {
        await store.completeSession(platformSession.id, {
          status: "failed",
          eveSessionId: pathSessionId,
          error: reason,
        });
      }
    };

    let upstream: Response;
    try {
      const forwardedHeaders = new Headers(c.req.raw.headers);
      forwardedHeaders.set(CANONICAL_REQUEST_ID_HEADER, requestId);
      const proxy = (envelope: string) =>
        playgroundProxy({
          projectId,
          path: `${evePath}${requestUrl.search}`,
          method: c.req.method,
          headers: forwardedHeaders,
          body,
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
          await failActiveTurn(
            `The turn was not delivered: Playground authentication failed (${recovery.failure.message})`,
          );
          return c.json(recovery.failure, agentAuthFailureStatus(recovery.failure));
        }
        const current = await agentAuth.resolveCurrentAgentAuthCredential(
          activeContext.connection.id,
          activeProvider.method,
          currentUserId(c),
          `/projects/${projectId}/playground`,
        );
        if (!current) {
          await failActiveTurn(
            "The turn was not delivered: Playground authentication changed mid-request. Retrying usually succeeds.",
          );
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
          await failActiveTurn(
            `The turn was not delivered: Playground authentication failed (${retryCredential.failure.message})`,
          );
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
          await failActiveTurn(`The turn was not delivered: ${failure.message}`);
          return c.json(failure, agentAuthFailureStatus(failure));
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await failActiveTurn(`The turn never reached the agent: ${message}`);
      return c.json({ error: "Playground request failed", detail: message }, 502);
    }

    if (!upstream.ok && platformSession && (isInitial || isContinuation)) {
      await failActiveTurn(await upstreamRejectionReason(upstream));
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
