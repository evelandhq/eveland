import type { RuntimeKind } from "@eveland/core/contracts";
import type { Store } from "@eveland/db";
import { createRuntimeAdapterForKind } from "./select.js";
import type { RuntimeAdapter } from "./types.js";

export async function reapIdleDeployments(
  store: Store,
  input: {
    now?: Date;
    idleTtlMs?: number;
    schedulePrewarmMs?: number;
    limit?: number;
    runtimeForKind?: (kind: RuntimeKind) => RuntimeAdapter;
  } = {},
): Promise<number> {
  const now = input.now ?? new Date();
  const instances = await store.claimIdleRuntimeInstances({
    now,
    idleTtlMs: input.idleTtlMs ?? 300_000,
    schedulePrewarmMs: input.schedulePrewarmMs ?? 0,
    limit: input.limit ?? 25,
  });
  let stopped = 0;
  for (const instance of instances) {
    const deployment = await store.getDeployment(instance.deploymentId);
    if (!deployment) {
      await store.updateRuntimeInstance(instance.id, { status: "failed", error: "Deployment no longer exists." }, now);
      continue;
    }
    if (await store.hasActiveActivationLeases(deployment.id, now)) {
      await store.updateRuntimeInstance(instance.id, { status: "ready" }, now);
      continue;
    }
    const runtime = (input.runtimeForKind ?? createRuntimeAdapterForKind)(deployment.runtimeKind);
    try {
      await runtime.stopProcess(deployment.containerName);
      await store.updateRuntimeInstance(instance.id, { status: "stopped", error: null }, now);
      await store.updateDeploymentStatus(deployment.id, "stopped");
      await store.appendLog({
        projectId: deployment.projectId,
        deploymentId: deployment.id,
        type: "runtime",
        line: `Stopped idle Deployment ${deployment.id} after its activation leases expired or were released.`,
      });
      stopped += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await store.updateRuntimeInstance(instance.id, { status: "failed", error: message }, now);
      await store.updateDeploymentStatus(deployment.id, "failed");
      await store.appendLog({
        projectId: deployment.projectId,
        deploymentId: deployment.id,
        type: "runtime",
        line: `Failed to stop idle Deployment ${deployment.id}: ${message}`,
      });
    }
  }
  return stopped;
}
