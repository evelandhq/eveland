import { inferEveRuntimeCommand } from "@eveland/core/server/runtime-command";
import { formatBuildInfo } from "@eveland/core/build-info";
import { createConfigurationSnapshot } from "@eveland/core/config-diagnostics";
import { createBuildInfoFromEnv } from "@eveland/core/server/build-info";
import { writeConfigurationSnapshotFile } from "@eveland/core/server/config-diagnostics";
import { createStoreFromEnv } from "@eveland/db/factory";
import { processNextJob } from "./jobs/process.js";
import { assertWorkerPreflight } from "./runtime/preflight.js";
import { bootstrapWorkflowWorld } from "./runtime/workflow-world-bootstrap.js";
import { reapIdleDeployments } from "./runtime/idle-reaper.js";
import { createOrphanProcessReaper } from "./runtime/orphan-reaper.js";
import { reconcileRuntimeInstances, recoverStartingRuntimeInstances } from "./runtime/activation-manager.js";
import { planDueSchedules } from "./scheduler/planner.js";

const intervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 5000);
const orphanSweepIntervalMs = Number(process.env.EVELAND_ORPHAN_SWEEP_INTERVAL_MS ?? 3_600_000);
const workerId = process.env.WORKER_ID ?? `worker-${process.pid}`;
const buildInfo = createBuildInfoFromEnv("worker", process.env);
const storeFactory = createStoreFromEnv();

// A misconfigured systemd host would otherwise only surface on the first
// deployment attempt; fail fast here with the complete list of what's missing.
try {
  await assertWorkerPreflight(process.env);
  const bootstrapLog = await bootstrapWorkflowWorld(process.env);
  if (bootstrapLog) console.log("Platform workflow-world database schema is ready.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

await writeConfigurationSnapshotFile(
  process.env.EVELAND_DATA_DIR ?? ".eveland-data",
  createConfigurationSnapshot("worker", process.env),
).catch(() => console.warn("Worker configuration diagnostics are unavailable."));

console.log(`${formatBuildInfo(buildInfo)} ready. Poll interval: ${intervalMs}ms`);
console.log(
  `Default eve runtime command: ${inferEveRuntimeCommand({
    scripts: {},
  })}`,
);

async function tick() {
  try {
    await Promise.all([
      planDueSchedules(storeFactory.store, {
        limit: Number(process.env.EVELAND_SCHEDULER_PLANNER_BATCH_SIZE ?? 25),
      }),
      reapIdleDeployments(storeFactory.store, {
        idleTtlMs: Number(process.env.EVELAND_ACTIVATION_IDLE_TTL_MS ?? 300_000),
        limit: Number(process.env.EVELAND_ACTIVATION_REAPER_BATCH_SIZE ?? 25),
      }),
      recoverStartingRuntimeInstances(storeFactory.store, {
        limit: Number(process.env.EVELAND_ACTIVATION_RECOVERY_BATCH_SIZE ?? 25),
        staleJobAfterMs: Number(process.env.EVELAND_ACTIVATION_START_STALE_MS ?? 300_000),
      }),
      reconcileRuntimeInstances(storeFactory.store, {
        limit: Number(process.env.EVELAND_ACTIVATION_RECONCILE_BATCH_SIZE ?? 100),
      }),
      processNextJob(storeFactory.store, workerId),
    ]);
  } catch (error) {
    console.error(error);
  }
}

void tick();
const timer = setInterval(() => {
  void tick();
}, intervalMs);

// Separate cadence from tick(): host process listing is comparatively heavy
// and orphan cleanup is not latency-sensitive. Set the interval to 0 to
// disable the sweep entirely.
const reapOrphanProcesses = createOrphanProcessReaper(storeFactory.store, {
  graceMs: Number(process.env.EVELAND_ORPHAN_GRACE_MS ?? 300_000),
});
const sweepOrphans = () => {
  reapOrphanProcesses().catch((error: unknown) => console.error("Orphan process sweep failed:", error));
};
let orphanTimer: NodeJS.Timeout | undefined;
if (orphanSweepIntervalMs > 0) {
  sweepOrphans();
  orphanTimer = setInterval(sweepOrphans, orphanSweepIntervalMs);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearInterval(timer);
    if (orphanTimer) clearInterval(orphanTimer);
    void storeFactory.close().finally(() => process.exit(0));
  });
}
