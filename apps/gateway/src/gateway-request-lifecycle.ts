import { createEveVersionInfo, unsupportedEveVersionMessage } from "@evelandhq/core/source";
import type { EveSessionRequest } from "@evelandhq/core/eve";
import type {
  OperationBinding,
  ResolvedAgentRoute,
  SessionBinding,
} from "@evelandhq/core/contracts";
import type { GatewayActivationClient, GatewayRepository } from "./gateway-types.js";
import {
  applyGatewaySessionResponse,
  type GatewaySessionProvenance,
} from "./gateway-session-lifecycle.js";
import {
  DownstreamAbortedError,
  RequestBodyTooLargeError,
  requestHasBody,
  resolveTarget,
  routeExperimentId,
} from "./gateway-routing.js";
import {
  proxyToDeployment,
  readLimitedBody,
  withNdjsonIdleHeartbeat,
} from "./gateway-transport.js";

// The request lifecycle shared by the public catch-all and the privileged
// Playground proxy: buffer the routing body, resolve the target, gate the Eve
// version, acquire and manage the activation lease, proxy, persist the
// session effect (compensating on failure), and wrap the client response.
// The handlers in app.ts own only what genuinely differs -- route lookup,
// session-lookup policy, header/provenance construction, and limits.

export function sessionExpiredResponse(): Response {
  return Response.json({ error: "Session expired", code: "session_expired" }, { status: 410 });
}

export function clientClosedResponse(): Response {
  return Response.json({ error: "Client closed request" }, { status: 499 });
}

export async function unsupportedDeploymentResponse(
  repository: GatewayRepository,
  deploymentId: string,
): Promise<Response | null> {
  const eveVersion =
    (await repository.getDeploymentEveVersion(deploymentId)) ?? createEveVersionInfo(null, null);
  if (eveVersion.supported) return null;
  return Response.json(
    {
      error: "Unsupported Eve version",
      detail: unsupportedEveVersionMessage(eveVersion.version),
      eveVersion,
    },
    { status: 409 },
  );
}

export function activationKind(
  request: EveSessionRequest | null,
): "public_request" | "stream" | "turn" {
  if (request?.kind === "stream") return "stream";
  if (request) return "turn";
  return "public_request";
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * Enforce the declared-length limit and buffer the body the session-routing
 * layer must inspect (create-once operation IDs on initial requests, and Eve
 * MCP tools). Non-JSON request kinds stay unread here (`body: undefined`) and
 * stream into the proxy step's own limited read.
 */
export async function readRoutingBody(input: {
  request: Request;
  eveRequest: EveSessionRequest | null;
  limitBytes: number;
}): Promise<{ ok: true; body: Uint8Array | null | undefined } | { ok: false; response: Response }> {
  const declaredContentLength = Number(input.request.headers.get("content-length"));
  if (Number.isFinite(declaredContentLength) && declaredContentLength > input.limitBytes) {
    return {
      ok: false,
      response: Response.json({ error: "Request body too large" }, { status: 413 }),
    };
  }
  const sniffsInitialBody = input.eveRequest?.kind === "initial";
  const sniffsJsonProtocol = input.request.headers
    .get("content-type")
    ?.includes("application/json");
  if (!sniffsInitialBody && !sniffsJsonProtocol) {
    return { ok: true, body: undefined };
  }
  try {
    const body = requestHasBody(input.request.method)
      ? await readLimitedBody(input.request.body, input.limitBytes, input.request.signal)
      : null;
    return { ok: true, body };
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return {
        ok: false,
        response: Response.json({ error: "Request body too large" }, { status: 413 }),
      };
    }
    if (error instanceof DownstreamAbortedError || input.request.signal.aborted) {
      return { ok: false, response: clientClosedResponse() };
    }
    throw error;
  }
}

export type GatewayUpstreamPolicy = {
  bodyLimitBytes: number;
  /** Socket idle timeout for the upstream hop, resolved by the caller. */
  timeoutMs: number;
  /**
   * Idle-heartbeat interval for eve NDJSON session streams; 0 (or absent)
   * disables injection. Blank-line heartbeats keep intermediaries from
   * reaping a silent stream without resetting the upstream idle timeout.
   */
  streamHeartbeatMs?: number;
  buildHeaders: (endpointPort: number) => Headers;
  /** Success-path response decoration (e.g. the affinity cookie). */
  decorateResponseHeaders?: (headers: Headers) => void;
};

export async function executeGatewaySessionProxy(input: {
  repository: GatewayRepository;
  activationClient: GatewayActivationClient | undefined;
  activationRenewIntervalMs: number;
  route: ResolvedAgentRoute;
  eveRequest: EveSessionRequest | null;
  binding: SessionBinding | null;
  operationBinding?: OperationBinding | null;
  operationKey?: string | null;
  targetKey: string;
  activationOwnerId: string;
  provenance: GatewaySessionProvenance;
  request: Request;
  routingBody: Uint8Array | null | undefined;
  upstreamPath: string;
  policy: GatewayUpstreamPolicy;
}): Promise<Response> {
  const { repository, activationClient, route, eveRequest, binding } = input;
  const signal = input.request.signal;
  const streamRequest = activationKind(eveRequest) === "stream";

  let effectiveOperationBinding = input.operationBinding ?? null;
  const routingBinding = binding ?? effectiveOperationBinding;
  let target = await resolveTarget(
    repository,
    route,
    routingBinding,
    input.targetKey,
    Boolean(activationClient),
  );
  if (!target) return Response.json({ error: "No running deployment target" }, { status: 503 });
  if (eveRequest) {
    const versionFailure = await unsupportedDeploymentResponse(repository, target.deploymentId);
    if (versionFailure) return versionFailure;
  }

  if (input.operationKey && !input.operationBinding) {
    const claimed = await repository.bindOperation({
      projectId: route.projectId,
      operationKey: input.operationKey,
      routeId: route.id,
      deploymentId: target.deploymentId,
      trigger: input.provenance.kind,
      variantName: target.variantName,
      experimentId: routeExperimentId(route),
    });
    effectiveOperationBinding = claimed;
    if (claimed.deploymentId !== target.deploymentId) {
      const claimedTarget = await resolveTarget(
        repository,
        route,
        claimed,
        input.targetKey,
        Boolean(activationClient),
      );
      if (!claimedTarget)
        return Response.json({ error: "No running deployment target" }, { status: 503 });
      target = claimedTarget;
      if (eveRequest) {
        const versionFailure = await unsupportedDeploymentResponse(repository, target.deploymentId);
        if (versionFailure) return versionFailure;
      }
    }
  }

  let activation: { leaseId: string; endpointPort: number } | null = null;
  if (activationClient) {
    try {
      activation = await activationClient.activate(
        {
          deploymentId: target.deploymentId,
          kind: activationKind(eveRequest),
          ownerId: input.activationOwnerId,
        },
        signal,
      );
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return clientClosedResponse();
      return Response.json({ error: "Deployment activation failed" }, { status: 503 });
    }
  }

  const endpointPort = activation?.endpointPort ?? target.hostPort;
  let upstream: Response;
  try {
    const body =
      input.routingBody !== undefined
        ? input.routingBody
        : requestHasBody(input.request.method)
          ? await readLimitedBody(input.request.body, input.policy.bodyLimitBytes, signal)
          : null;
    upstream = await proxyToDeployment({
      port: endpointPort,
      path: input.upstreamPath,
      method: input.request.method,
      headers: input.policy.buildHeaders(endpointPort),
      body,
      signal,
      timeoutMs: input.policy.timeoutMs,
      idleTimeoutMode: streamRequest ? "end" : "abort",
    });
  } catch (error) {
    if (activation && activationClient)
      await activationClient.release(activation.leaseId).catch(() => undefined);
    if (error instanceof RequestBodyTooLargeError)
      return Response.json({ error: "Request body too large" }, { status: 413 });
    if (error instanceof DownstreamAbortedError) return clientClosedResponse();
    throw error;
  }

  try {
    await applyGatewaySessionResponse({
      repository,
      projectId: route.projectId,
      request: eveRequest,
      upstream,
      target: {
        routeId: effectiveOperationBinding?.routeId ?? route.id,
        deploymentId: target.deploymentId,
        variantName: effectiveOperationBinding
          ? effectiveOperationBinding.variantName
          : target.variantName,
        experimentId: effectiveOperationBinding
          ? effectiveOperationBinding.experimentId
          : routeExperimentId(route),
      },
      provenance: input.provenance,
    });
  } catch (error) {
    await cancelUpstreamAndReleaseActivation(upstream, error, activation, activationClient);
    throw error;
  }

  const responseHeaders = new Headers(upstream.headers);
  input.policy.decorateResponseHeaders?.(responseHeaders);
  const heartbeatMs = input.policy.streamHeartbeatMs ?? 0;
  const responseBody =
    streamRequest &&
    heartbeatMs > 0 &&
    upstream.body !== null &&
    upstream.headers.get("x-eve-stream-format") === "ndjson"
      ? withNdjsonIdleHeartbeat(upstream.body, heartbeatMs)
      : upstream.body;
  const response = new Response(responseBody, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
  return activation && activationClient
    ? manageActivationResponse(
        response,
        activationClient,
        activation.leaseId,
        input.activationRenewIntervalMs,
      )
    : response;
}

export async function cancelUpstreamAndReleaseActivation(
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

export function manageActivationResponse(
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
