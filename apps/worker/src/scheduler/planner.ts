import type { Store } from "@evelandhq/db";

export async function planDueSchedules(
  store: Store,
  input: { now?: Date; limit?: number; prewarmMs?: number; activationLeaseTtlMs?: number } = {},
): Promise<number> {
  const now = input.now ?? new Date();
  const limit = input.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Scheduler planner batch size must be between 1 and 100.");
  }
  const prewarmMs = input.prewarmMs ?? 0;
  if (!Number.isFinite(prewarmMs) || prewarmMs < 0) {
    throw new Error("Scheduler prewarm window must be non-negative.");
  }
  const runs = await store.claimDueScheduleRuns({ now, limit });
  if (prewarmMs > 0) {
    const dueDeploymentIds = new Set(runs.map((run) => run.deploymentId));
    const activationLeaseTtlMs = input.activationLeaseTtlMs ?? prewarmMs + 10_000;
    if (!Number.isFinite(activationLeaseTtlMs) || activationLeaseTtlMs <= prewarmMs) {
      throw new Error("Scheduler prewarm activation lease must outlive the prewarm window.");
    }
    const upcoming = await store.listUpcomingScheduleTargets({
      after: now,
      before: new Date(now.getTime() + prewarmMs),
      limit,
    });
    for (const candidate of upcoming) {
      if (dueDeploymentIds.has(candidate.deploymentId)) continue;
      try {
        const claim = await store.acquireActivationLease({
          deploymentId: candidate.deploymentId,
          kind: "schedule_run",
          ownerId: `prewarm:${candidate.scheduleId}`,
          expiresAt: new Date(now.getTime() + activationLeaseTtlMs),
          now,
        });
        if (claim.runtimeInstance.status === "starting") {
          await store.enqueueDeploymentActivation(
            candidate.projectId,
            candidate.deploymentId,
            claim.runtimeInstance.id,
            now,
          );
        }
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("draining")) throw error;
      }
    }
  }
  return runs.length;
}
