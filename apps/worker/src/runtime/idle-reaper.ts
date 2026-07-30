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
    // claimIdleRuntimeInstances handed this instance over in "draining"; a
    // restart_deployment job retires live instances of its Deployment as it goes,
    // so a different status now means the restart owns this process. Stopping it
    // would kill a freshly restarted Agent and report the Deployment stopped.
    const claimed = await store.getRuntimeInstance(instance.id);
    if (claimed?.status !== "draining") continue;
    try {
      await runtime.stopProcess(deployment.containerName);
      await store.updateRuntimeInstance(instance.id, { status: "stopped", error: null }, now);
      // Only a live row is this sweeper's to write: archive_deployment leaves its
      // RuntimeInstance rows in place, so an unguarded write un-archives a
      // retired Deployment.
      await store.transitionDeploymentStatus({
        deploymentId: deployment.id,
        to: "stopped",
        from: ["running", "draining"],
      });
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
      await store.transitionDeploymentStatus({
        deploymentId: deployment.id,
        to: "failed",
        from: ["running", "draining"],
      });
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
