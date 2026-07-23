import { inferEveRuntimeCommand } from "@eveland/core/server/runtime-command";
import { formatBuildInfo } from "@eveland/core/build-info";
import { createConfigurationSnapshot } from "@eveland/core/config-diagnostics";
import { createBuildInfoFromEnv } from "@eveland/core/server/build-info";
import { writeConfigurationSnapshotFile } from "@eveland/core/server/config-diagnostics";
import { createStoreFromEnv } from "@eveland/db/factory";
import { cleanupExpiredSourcePreflights, processNextJob, processNextSourcePreflight } from "./jobs/process.js";
import { assertWorkerPreflight } from "./runtime/preflight.js";
import { bootstrapWorkflowWorld } from "./runtime/workflow-world-bootstrap.js";
import { reapIdleDeployments } from "./runtime/idle-reaper.js";
import { createOrphanProcessReaper } from "./runtime/orphan-reaper.js";
import { sweepReleaseRetention } from "./runtime/release-reaper.js";
import { reconcileRuntimeInstances, recoverStartingRuntimeInstances } from "./runtime/activation-manager.js";
import { planDueSchedules } from "./scheduler/planner.js";
import { createWorkerTelemetry } from "./runtime/worker-telemetry.js";
import {
  reconcileIdentityDeploymentConfiguration,
  resolveIdentityDeploymentConfiguration,
} from "./runtime/identity-config-reconciler.js";
import { createDeploymentObservabilityReconciler } from "./jobs/process-observability.js";

const intervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 5000);
const schedulerPrewarmMs = Number(process.env.EVELAND_SCHEDULER_PREWARM_MS ?? 60_000);
const orphanSweepIntervalMs = Number(process.env.EVELAND_ORPHAN_SWEEP_INTERVAL_MS ?? 3_600_000);
const releaseSweepIntervalMs = Number(
  process.env.EVELAND_RELEASE_SWEEP_INTERVAL_MS ?? 3_600_000,
);
const workerId = process.env.WORKER_ID ?? `worker-${process.pid}`;
const dataDir = process.env.EVELAND_DATA_DIR ?? ".eveland-data";
const buildInfo = createBuildInfoFromEnv("worker", process.env);
const storeFactory = createStoreFromEnv();
const reconcileDeploymentObservability =
  createDeploymentObservabilityReconciler({
    store: storeFactory.store,
    env: process.env,
    nodeEnv: process.env.NODE_ENV,
  });

// A misconfigured systemd host would otherwise only surface on the first
// deployment attempt; fail fast here with the complete list of what's missing.
try {
  await assertWorkerPreflight(process.env);
  const bootstrapLog = await bootstrapWorkflowWorld(process.env);
  if (bootstrapLog) console.log("Platform workflow-world database schema is ready.");
  const identityConfiguration = resolveIdentityDeploymentConfiguration({
    dataDir,
    nodeEnv: process.env.NODE_ENV,
    issuer: process.env.EVELAND_IDENTITY_ISSUER,
    jwksUrl: process.env.EVELAND_IDENTITY_JWKS_URL,
  });
  if (identityConfiguration) {
    const restartJobs =
      await reconcileIdentityDeploymentConfiguration(
        storeFactory.store,
        identityConfiguration,
      );
    if (restartJobs.length > 0) {
      console.log(
        `Identity configuration changed; queued ${restartJobs.length} live Deployment restart${restartJobs.length === 1 ? "" : "s"}.`,
      );
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

await writeConfigurationSnapshotFile(
  dataDir,
  createConfigurationSnapshot("worker", process.env),
).catch(() => console.warn("Worker configuration diagnostics are unavailable."));

console.log(`${formatBuildInfo(buildInfo)} ready. Poll interval: ${intervalMs}ms`);
console.log(
  `Default eve runtime command: ${inferEveRuntimeCommand({
    scripts: {},
  })}`,
);

const telemetry = createWorkerTelemetry(storeFactory.store, {
  workerId,
  dataDir,
  intervalMs,
  metricIntervalMs: Number(process.env.EVELAND_HOST_METRIC_INTERVAL_MS ?? 60_000),
  retentionMs: Number(process.env.EVELAND_HOST_METRIC_RETENTION_MS ?? 2_592_000_000),
  onMetricError: (error) => console.warn("Worker host metrics are unavailable:", error instanceof Error ? error.message : String(error)),
});
let lastTickDurationMs = 0;
let lastTickError: unknown | null = null;
let telemetryPublishing = false;

function publishTelemetry() {
  if (telemetryPublishing) return;
  telemetryPublishing = true;
  telemetry.publishTick({ durationMs: lastTickDurationMs, error: lastTickError })
    .catch((error: unknown) => console.warn("Worker heartbeat is unavailable:", error instanceof Error ? error.message : String(error)))
    .finally(() => { telemetryPublishing = false; });
}

async function tick() {
  const startedAt = Date.now();
  try {
    await Promise.all([
      planDueSchedules(storeFactory.store, {
        limit: Number(process.env.EVELAND_SCHEDULER_PLANNER_BATCH_SIZE ?? 25),
        prewarmMs: schedulerPrewarmMs,
        activationLeaseTtlMs: schedulerPrewarmMs + Math.max(10_000, intervalMs * 2),
      }),
      reapIdleDeployments(storeFactory.store, {
        idleTtlMs: Number(process.env.EVELAND_ACTIVATION_IDLE_TTL_MS ?? 300_000),
        schedulePrewarmMs: schedulerPrewarmMs,
        limit: Number(process.env.EVELAND_ACTIVATION_REAPER_BATCH_SIZE ?? 25),
      }),
      recoverStartingRuntimeInstances(storeFactory.store, {
        limit: Number(process.env.EVELAND_ACTIVATION_RECOVERY_BATCH_SIZE ?? 25),
        staleJobAfterMs: Number(process.env.EVELAND_ACTIVATION_START_STALE_MS ?? 300_000),
      }),
      reconcileRuntimeInstances(storeFactory.store, {
        limit: Number(process.env.EVELAND_ACTIVATION_RECONCILE_BATCH_SIZE ?? 100),
      }),
      reconcileDeploymentObservability(),
      storeFactory.store.recoverStaleJobs(
        new Date(),
        Number(process.env.WORKER_JOB_STALE_MS ?? 120_000),
        Number(process.env.WORKER_JOB_RECOVERY_BATCH_SIZE ?? 25),
      ),
      storeFactory.store.recoverStaleSourcePreflights(
        new Date(),
        Number(process.env.WORKER_JOB_STALE_MS ?? 120_000),
        Number(process.env.WORKER_JOB_RECOVERY_BATCH_SIZE ?? 25),
      ),
      cleanupExpiredSourcePreflights(storeFactory.store),
      processNextSourcePreflight(storeFactory.store, workerId),
      processNextJob(storeFactory.store, workerId),
    ]);
    lastTickError = null;
  } catch (error) {
    lastTickError = error;
    console.error(error);
  } finally {
    lastTickDurationMs = Date.now() - startedAt;
  }
}

void tick();
publishTelemetry();
const timer = setInterval(() => {
  void tick();
}, intervalMs);
const telemetryTimer = setInterval(publishTelemetry, intervalMs);

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

const sweepReleases = () => {
  sweepReleaseRetention(storeFactory.store, {
    keepRecent: Number(process.env.EVELAND_RELEASE_RETENTION ?? 3),
    limit: Number(process.env.EVELAND_RELEASE_SWEEP_BATCH_SIZE ?? 25),
    playgroundIdleTtlMs: Number(
      process.env.EVELAND_PLAYGROUND_SESSION_IDLE_TTL_MS ?? 86_400_000,
    ),
    apiIdleTtlMs: Number(
      process.env.EVELAND_API_SESSION_IDLE_TTL_MS ?? 604_800_000,
    ),
  }).catch((error: unknown) =>
    console.error(
      "Release retention sweep failed:",
      error instanceof Error ? error.message : String(error),
    ),
  );
};
let releaseTimer: NodeJS.Timeout | undefined;
if (releaseSweepIntervalMs > 0) {
  sweepReleases();
  releaseTimer = setInterval(sweepReleases, releaseSweepIntervalMs);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearInterval(timer);
    clearInterval(telemetryTimer);
    if (orphanTimer) clearInterval(orphanTimer);
    if (releaseTimer) clearInterval(releaseTimer);
    void storeFactory.close().finally(() => process.exit(0));
  });
}
