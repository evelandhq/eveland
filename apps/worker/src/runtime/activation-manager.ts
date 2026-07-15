import type { ActivationLeaseClaim, ActivationLeaseKind, DeploymentRecord } from "@eveland/core/contracts";
import type { Store } from "@eveland/db";
import { waitForHttpHealth } from "./health.js";
import type { ProcessStartInput, RuntimeAdapter } from "./types.js";

export type DeploymentActivationInput = {
  deployment: DeploymentRecord;
  runtime: RuntimeAdapter;
  startInput: ProcessStartInput;
  kind: ActivationLeaseKind;
  ownerId: string;
};

export type DeploymentActivationOptions = {
  leaseTtlMs?: number;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => Date;
  waitForHealth?: (input: { host: string; port: number; timeoutMs: number }) => Promise<void>;
};

export async function ensureDeploymentActive(
  store: Store,
  input: DeploymentActivationInput,
  options: DeploymentActivationOptions = {},
): Promise<ActivationLeaseClaim> {
  const now = options.now ?? (() => new Date());
  const leaseTtlMs = options.leaseTtlMs ?? 180_000;
  const readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
  const claimed = await store.acquireActivationLease({
    deploymentId: input.deployment.id,
    kind: input.kind,
    ownerId: input.ownerId,
    expiresAt: new Date(now().getTime() + leaseTtlMs),
    now: now(),
  });

  if (claimed.runtimeInstance.status === "ready") return claimed;
  if (claimed.starter) {
    try {
      const start = input.runtime.ensureProcess?.bind(input.runtime) ?? input.runtime.startProcess.bind(input.runtime);
      await start(input.startInput);
      await (options.waitForHealth ?? waitForHttpHealth)({
        host: "127.0.0.1",
        port: input.deployment.hostPort,
        timeoutMs: readyTimeoutMs,
      });
      const ready = await store.updateRuntimeInstance(claimed.runtimeInstance.id, {
        status: "ready",
        endpointHost: "127.0.0.1",
        endpointPort: input.deployment.hostPort,
        error: null,
      }, now());
      if (!ready) throw new Error("RuntimeInstance disappeared during activation.");
      return { ...claimed, runtimeInstance: ready };
    } catch (error) {
      await store.updateRuntimeInstance(claimed.runtimeInstance.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      }, now());
      await store.releaseActivationLease(claimed.lease.id, now());
      throw error;
    }
  }

  try {
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      const current = await store.getRuntimeInstance(claimed.runtimeInstance.id);
      if (!current) throw new Error("RuntimeInstance disappeared during activation.");
      if (current.status === "ready") return { ...claimed, runtimeInstance: current };
      if (current.status === "failed" || current.status === "stopped") {
        throw new Error(current.lastError ?? `Runtime activation ended in ${current.status}.`);
      }
      await delay(options.pollIntervalMs ?? 10);
    }
    throw new Error(`Runtime activation timed out after ${readyTimeoutMs}ms.`);
  } catch (error) {
    await store.releaseActivationLease(claimed.lease.id, now());
    throw error;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
