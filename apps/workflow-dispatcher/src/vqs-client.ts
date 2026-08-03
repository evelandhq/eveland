import {
  DEPLOYMENT_HEADER,
  DISPATCH_VERSION,
  DISPATCH_VERSION_HEADER,
  RUN_HEADER,
  RUNTIME_SECRET_HEADER,
  TENANT_HEADER,
  VQS_MESSAGE_ATTEMPT_HEADER,
  VQS_MESSAGE_ID_HEADER,
  VQS_QUEUE_NAME_HEADER,
} from "@eveland/workflow-world";

/**
 * The dispatcher's half of the dispatch contract: one held POST per in-flight
 * step, to the deployment's loopback port.
 *
 * The response vocabulary mirrors what the embedded runner does, because the
 * runtime cannot tell the two apart:
 *   * `{ok:true}`      → the job is done;
 *   * `{timeoutSeconds}` → not done; the caller must re-enqueue the *same*
 *     messageId with that delay. eve uses this as its delayed backstop and the
 *     runtime's step-ownership lease keys off the message id, so minting a new
 *     one here would silently degrade crash recovery.
 */
export type VqsResult =
  | { type: "completed" }
  | { type: "reschedule"; timeoutSeconds: number }
  | { type: "error"; status: number; text: string; retryable: boolean };

export type VqsRequest = {
  endpointPort: number;
  route: "flow" | "step";
  queueName: string;
  messageId: string;
  attempt: number;
  body: Uint8Array;
  headers?: Record<string, string>;
  tenantId: string;
  deploymentId: string;
  runId?: string;
  runtimeSecret: string;
  credential: string;
  timeoutMs: number;
  signal?: AbortSignal;
};

export const WORKFLOW_ROUTE_BASE = "/.well-known/workflow/v1";

export async function postVqsMessage(request: VqsRequest): Promise<VqsResult> {
  const url = `http://127.0.0.1:${String(request.endpointPort)}${WORKFLOW_ROUTE_BASE}/${request.route}`;
  const headers: Record<string, string> = {
    ...request.headers,
    "content-type": "application/json",
    // eve's own headers. Names are fixed by the runtime; do not rename.
    [VQS_QUEUE_NAME_HEADER]: request.queueName,
    [VQS_MESSAGE_ID_HEADER]: request.messageId,
    [VQS_MESSAGE_ATTEMPT_HEADER]: String(request.attempt),
    // Eveland's. The secret is what distinguishes platform dispatch from a
    // request that merely reached the same route.
    authorization: `Bearer ${request.credential}`,
    [RUNTIME_SECRET_HEADER]: request.runtimeSecret,
    [DISPATCH_VERSION_HEADER]: String(DISPATCH_VERSION),
    [TENANT_HEADER]: request.tenantId,
    [DEPLOYMENT_HEADER]: request.deploymentId,
    ...(request.runId ? { [RUN_HEADER]: request.runId } : {}),
  };

  const timeout = AbortSignal.timeout(request.timeoutMs);
  const signal = request.signal ? AbortSignal.any([timeout, request.signal]) : timeout;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: request.body as BodyInit,
      signal,
      // @ts-expect-error -- Node accepts `duplex` for streaming bodies; it is
      // not in the DOM lib types.
      duplex: "half",
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const timedOut = name === "TimeoutError" || name === "AbortError";
    return {
      type: "error",
      status: 0,
      text: timedOut ? `Dispatch timed out after ${String(request.timeoutMs)}ms.` : String(error),
      // A dead or restarting executor is exactly what retries exist for.
      retryable: true,
    };
  }

  const text = await response.text();
  if (!response.ok) {
    return {
      type: "error",
      status: response.status,
      text,
      // 4xx means this deployment will never accept the message — a malformed
      // dispatch or a version it refuses. Retrying just burns the budget.
      retryable: response.status >= 500,
    };
  }

  try {
    const timeoutSeconds = Number(
      (JSON.parse(text) as { timeoutSeconds?: unknown }).timeoutSeconds,
    );
    if (Number.isFinite(timeoutSeconds) && timeoutSeconds >= 0) {
      return { type: "reschedule", timeoutSeconds };
    }
  } catch {
    // A non-JSON 2xx body means "done"; upstream treats it the same way.
  }
  return { type: "completed" };
}
