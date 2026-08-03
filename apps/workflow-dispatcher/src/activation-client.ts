/**
 * Client for the control API's runtime activation endpoints.
 *
 * Modelled on the gateway's client ([apps/gateway/src/activation-client.ts]),
 * with one addition that matters here: the lease must be *renewed* for as long
 * as a step is running. The gateway holds a lease for the length of an HTTP
 * request; a workflow step can be a model call with no bound, and the lease TTL
 * (`EVELAND_ACTIVATION_LEASE_TTL_MS`, 180s by default) is far shorter than that.
 * A dispatcher that acquired and forgot would have the idle reaper stop the
 * executor out from under a step that was still running.
 */
export type Activation = {
  leaseId: string;
  endpointPort: number;
};

export type ActivationOutcome =
  | { type: "activated"; activation: Activation }
  | { type: "not-activatable"; status: number; message: string }
  | { type: "unavailable"; status: number; message: string };

export type ActivationClient = {
  activate(input: {
    deploymentId: string;
    kind: string;
    ownerId: string;
    signal?: AbortSignal;
  }): Promise<ActivationOutcome>;
  renew(leaseId: string): Promise<boolean>;
  release(leaseId: string): Promise<void>;
};

export function createActivationClient(input: {
  apiUrl: string;
  serviceToken: string;
  drainRetryMs?: number;
  maxDrainRetries?: number;
}): ActivationClient {
  const apiUrl = input.apiUrl.replace(/\/$/, "");
  const headers = {
    authorization: `Bearer ${input.serviceToken}`,
    "content-type": "application/json",
  };
  const drainRetryMs = input.drainRetryMs ?? 250;
  const maxDrainRetries = input.maxDrainRetries ?? 20;

  return {
    async activate(activation) {
      let response: Response;
      let drainAttempts = 0;
      for (;;) {
        response = await fetch(`${apiUrl}/internal/runtime/activations`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            deploymentId: activation.deploymentId,
            kind: activation.kind,
            ownerId: activation.ownerId,
          }),
          ...(activation.signal ? { signal: activation.signal } : {}),
        });
        // 425 means the deployment is draining. Unlike the gateway, which is
        // serving a user waiting on a response, this is background work — so it
        // is bounded rather than retried indefinitely, and falls through to a
        // graphile retry when the drain outlasts the budget.
        if (response.status !== 425) break;
        drainAttempts += 1;
        if (drainAttempts > maxDrainRetries) {
          return {
            type: "unavailable",
            status: 425,
            message: "Deployment is still draining after the activation retry budget.",
          };
        }
        await sleep(drainRetryMs);
      }

      if (response.status === 409) {
        // Archived or failed: no executor will ever exist for this run. Retrying
        // cannot help, so the caller must dead-letter rather than burn attempts.
        return {
          type: "not-activatable",
          status: 409,
          message: await readError(response),
        };
      }
      if (!response.ok) {
        return {
          type: "unavailable",
          status: response.status,
          message: await readError(response),
        };
      }

      const value = (await response.json().catch(() => null)) as {
        lease?: { id?: unknown };
        runtimeInstance?: { endpointPort?: unknown };
      } | null;
      if (
        !value ||
        typeof value.lease?.id !== "string" ||
        typeof value.runtimeInstance?.endpointPort !== "number"
      ) {
        return {
          type: "unavailable",
          status: response.status,
          message: "Control API returned an invalid activation result.",
        };
      }
      return {
        type: "activated",
        activation: {
          leaseId: value.lease.id,
          endpointPort: value.runtimeInstance.endpointPort,
        },
      };
    },

    async renew(leaseId) {
      const response = await fetch(
        `${apiUrl}/internal/runtime/activations/${encodeURIComponent(leaseId)}/renew`,
        { method: "POST", headers },
      );
      return response.ok;
    },

    async release(leaseId) {
      await fetch(`${apiUrl}/internal/runtime/activations/${encodeURIComponent(leaseId)}`, {
        method: "DELETE",
        headers,
      }).catch(() => undefined);
    },
  };
}

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string"
    ? body.error
    : `Control API responded with HTTP ${String(response.status)}.`;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
