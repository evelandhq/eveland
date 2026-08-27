import type { GatewayActivationClient } from "./app.js";

export function createApiActivationClient(input: {
  apiUrl: string;
  serviceToken: string;
  drainRetryMs?: number;
}): GatewayActivationClient {
  const apiUrl = input.apiUrl.replace(/\/$/, "");
  const headers = {
    authorization: `Bearer ${input.serviceToken}`,
    "content-type": "application/json",
  };
  return {
    async activate(activation, signal) {
      let response: Response;
      for (;;) {
        response = await fetch(`${apiUrl}/internal/runtime/activations`, {
          method: "POST",
          headers,
          body: JSON.stringify(activation),
          signal,
        });
        if (response.status !== 425) break;
        await waitForRetry(input.drainRetryMs ?? 25, signal);
      }
      if (!response.ok) {
        // Carry the control API's reason (cold-start timeout, failed
        // RuntimeInstance, workflow gate) instead of collapsing it to a bare
        // status — it ends up in the failed session's stored error (#294).
        const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
        const reason = typeof body?.error === "string" ? `: ${body.error.slice(0, 500)}` : ".";
        throw new Error(`Control API activation failed with HTTP ${response.status}${reason}`);
      }
      const value = (await response.json().catch(() => null)) as {
        lease?: { id?: unknown };
        runtimeInstance?: { id?: unknown; endpointPort?: unknown };
      } | null;
      if (
        !value ||
        typeof value.lease?.id !== "string" ||
        typeof value.runtimeInstance?.id !== "string" ||
        typeof value.runtimeInstance?.endpointPort !== "number"
      ) {
        throw new Error("Control API returned an invalid activation result.");
      }
      return {
        leaseId: value.lease.id,
        runtimeInstanceId: value.runtimeInstance.id,
        endpointPort: value.runtimeInstance.endpointPort,
      };
    },
    async renew(leaseId) {
      const response = await fetch(
        `${apiUrl}/internal/runtime/activations/${encodeURIComponent(leaseId)}/renew`,
        {
          method: "POST",
          headers,
        },
      );
      if (!response.ok)
        throw new Error(`Control API activation renewal failed with HTTP ${response.status}.`);
    },
    async release(leaseId) {
      const response = await fetch(
        `${apiUrl}/internal/runtime/activations/${encodeURIComponent(leaseId)}`,
        {
          method: "DELETE",
          headers,
        },
      );
      if (!response.ok)
        throw new Error(`Control API activation release failed with HTTP ${response.status}.`);
    },
  };
}

function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Activation aborted.", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Activation aborted.", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
