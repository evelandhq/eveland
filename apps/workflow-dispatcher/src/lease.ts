import type { ActivationClient } from "./activation-client.js";

/**
 * Holds an activation lease for the whole of `body`, renewing on an interval.
 *
 * This is the piece that makes long steps survive. The lease both keeps the
 * idle reaper away from the deployment and registers as `active_request` in the
 * control plane's retention accounting, so a running step also protects its
 * deployment from being archived. Neither holds if the lease is allowed to
 * expire mid-step.
 *
 * A failed renewal aborts the in-flight request rather than letting it run on
 * against an executor the platform now considers idle: better a retryable
 * failure than a step that is silently no longer protected.
 */
export async function withRenewedLease<T>(
  input: {
    client: ActivationClient;
    leaseId: string;
    renewIntervalMs: number;
    onRenewFailure?: (leaseId: string) => void;
  },
  body: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setInterval(() => {
    void input.client
      .renew(input.leaseId)
      .then((renewed) => {
        if (renewed) return;
        input.onRenewFailure?.(input.leaseId);
        controller.abort(
          new Error(`Activation lease ${input.leaseId} could not be renewed; aborting dispatch.`),
        );
      })
      .catch((error: unknown) => {
        input.onRenewFailure?.(input.leaseId);
        controller.abort(error instanceof Error ? error : new Error(String(error)));
      });
  }, input.renewIntervalMs);
  // Renewal must never be the reason the process stays alive.
  timer.unref?.();

  try {
    return await body(controller.signal);
  } finally {
    clearInterval(timer);
    await input.client.release(input.leaseId);
  }
}
