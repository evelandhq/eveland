import {
  capacityObservability,
  platformObservability,
  runtimeObservability,
  workerInstanceId,
} from "./observability.js";
import { SpanStatusCode } from "@opentelemetry/api";
import { formatBuildInfo } from "@evelandhq/core/build-info";
import { createConfigurationSnapshot } from "@evelandhq/core/config-diagnostics";
import { createBuildInfoFromEnv } from "@evelandhq/core/server/build-info";
import { writeConfigurationSnapshotFile } from "@evelandhq/core/server/config-diagnostics";
import { listenForQueuedJobs } from "@evelandhq/db";
import { createStoreFromEnv } from "@evelandhq/db/factory";
import { runClaimedJob } from "./jobs/process.js";
import {
  cleanupExpiredSourcePreflights,
  runClaimedSourcePreflight,
} from "./jobs/process-source-preflight.js";
import {
  resolveMaxConcurrentHeavyJobs,
  resolveWorkerJobConcurrency,
} from "./runtime/job-concurrency.js";
import { nonOverlapping, startJobPump } from "./runtime/job-pump.js";
import { assertWorkerPreflight } from "./runtime/preflight.js";
import { assertWorkflowTopologyPreflight } from "./runtime/workflow-topology-preflight.js";
import { bootstrapWorkflowWorld } from "./runtime/workflow-world-bootstrap.js";
import { bootstrapEvelandWorkflowWorld } from "./runtime/eveland-workflow-world-bootstrap.js";
import { reapIdleDeployments } from "./runtime/idle-reaper.js";
import { createOrphanProcessReaper } from "./runtime/orphan-reaper.js";
import { sweepReleaseRetention } from "./runtime/release-reaper.js";
import { reconcileAbandonedWorkflowRuns } from "./runtime/workflow-run-reconciler.js";
import { sweepWorkflowStreamRetention } from "./runtime/workflow-world-reaper.js";
import {
  formatWorkflowStreamRetentionSummary,
  runWorkflowStreamRetentionSweep,
  startWorkflowStreamRetentionScheduler,
} from "./runtime/workflow-stream-retention.js";
import {
  reconcileRuntimeInstances,
  recoverStartingRuntimeInstances,
} from "./runtime/activation-manager.js";
import { planDueSchedules } from "./scheduler/planner.js";
import { createWorkerTelemetry } from "./runtime/worker-telemetry.js";
import {
  reconcileIdentityDeploymentConfiguration,
  resolveIdentityDeploymentConfiguration,
} from "./runtime/identity-config-reconciler.js";
import { createDeploymentObservabilityReconciler } from "./jobs/process-observability.js";
import { createCollectorObservabilityReconciler } from "./jobs/process-collector-observability.js";
import { createObservabilityRetentionReconciler } from "./jobs/process-observability-retention.js";
import { createExternalDestinationHealthReconciler } from "./jobs/process-observability-destination-health.js";
import { instrumentRuntimeLogStore } from "./runtime/runtime-log-store.js";
import { createAgentTelemetryNetworkReconciler } from "./runtime/docker/agent-network.js";
import { resolveRuntimeKind } from "./runtime/select.js";
import { createWorkerObservabilityReconciler } from "./runtime/observability/reconciler.js";

const intervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 5000);
const schedulerPrewarmMs = Number(process.env.EVELAND_SCHEDULER_PREWARM_MS ?? 60_000);
const orphanSweepIntervalMs = Number(process.env.EVELAND_ORPHAN_SWEEP_INTERVAL_MS ?? 3_600_000);
const releaseSweepIntervalMs = Number(process.env.EVELAND_RELEASE_SWEEP_INTERVAL_MS ?? 3_600_000);
const workflowSweepIntervalMs = Number(process.env.EVELAND_WORKFLOW_SWEEP_INTERVAL_MS ?? 3_600_000);
const workflowRunReconcileIntervalMs = Number(
  process.env.EVELAND_WORKFLOW_RUN_RECONCILE_INTERVAL_MS ?? 60_000,
);
const workerId = workerInstanceId;
const dataDir = process.env.EVELAND_DATA_DIR ?? ".eveland-data";
const maxConcurrentHeavyJobs = resolveMaxConcurrentHeavyJobs(process.env);
const jobConcurrency = resolveWorkerJobConcurrency(process.env);
const buildInfo = createBuildInfoFromEnv("worker", process.env);
const storeFactory = createStoreFromEnv();
const store = instrumentRuntimeLogStore(storeFactory.store, runtimeObservability);
const reconcileDeploymentObservability = createDeploymentObservabilityReconciler({
  store,
  env: process.env,
  nodeEnv: process.env.NODE_ENV,
});
const reconcileCollectorObservability = createCollectorObservabilityReconciler({
  store,
  env: process.env,
});
const reconcileObservabilityRetention = createObservabilityRetentionReconciler({
  store,
});
const reconcileExternalDestinationHealth = createExternalDestinationHealthReconciler({
  store,
  appSecretKey: process.env.APP_SECRET_KEY ?? "eveland-dev-secret-key-000000000",
});
const reconcileAgentTelemetryNetworks =
  resolveRuntimeKind(process.env) === "docker"
    ? createAgentTelemetryNetworkReconciler(process.env.EVELAND_OTEL_COLLECTOR_CONTAINER)
    : undefined;
const reconcileObservability = createWorkerObservabilityReconciler([
  {
    name: "Deployment observability policy",
    run: reconcileDeploymentObservability,
  },
  {
    name: "OpenTelemetry Collector configuration",
    run: reconcileCollectorObservability,
  },
  {
    name: "Observability retention",
    run: reconcileObservabilityRetention,
  },
  {
    name: "External observability destination health",
    run: reconcileExternalDestinationHealth,
  },
  ...(reconcileAgentTelemetryNetworks
    ? [
        {
          name: "Docker Agent telemetry network",
          run: reconcileAgentTelemetryNetworks,
        },
      ]
    : []),
]);

// A misconfigured systemd host would otherwise only surface on the first
// deployment attempt; fail fast here with the complete list of what's missing.
try {
  await assertWorkerPreflight(process.env);
  assertWorkflowTopologyPreflight(process.env);
  await bootstrapWorkflowWorld(process.env);
  if (await bootstrapEvelandWorkflowWorld(process.env)) {
    console.log("Shared workflow-world database schema is ready.");
  }
  const identityConfiguration = resolveIdentityDeploymentConfiguration({
    dataDir,
    nodeEnv: process.env.NODE_ENV,
    issuer: process.env.EVELAND_IDENTITY_ISSUER || process.env.EVELAND_PUBLIC_ORIGIN,
    jwksUrl: process.env.EVELAND_IDENTITY_JWKS_URL,
  });
  if (identityConfiguration) {
    const restartJobs = await reconcileIdentityDeploymentConfiguration(
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

console.log(
  `${formatBuildInfo(buildInfo)} ready. Poll interval: ${intervalMs}ms. Job concurrency: ${jobConcurrency}${process.env.WORKER_JOB_CONCURRENCY ? " (WORKER_JOB_CONCURRENCY)" : " (derived from machine spec)"}. Concurrent build limit: ${maxConcurrentHeavyJobs}${process.env.EVELAND_MAX_CONCURRENT_JOBS ? " (EVELAND_MAX_CONCURRENT_JOBS)" : " (derived from machine spec)"}.`,
);
platformObservability.emitLog({
  severity: "info",
  eventName: "eveland.worker.ready",
  body: "Eveland Worker is ready.",
  attributes: {
    "eveland.worker.poll_interval_ms": intervalMs,
    "eveland.worker.job_concurrency": jobConcurrency,
    "eveland.worker.max_concurrent_heavy_jobs": maxConcurrentHeavyJobs,
  },
});

const telemetry = createWorkerTelemetry(capacityObservability.meter, {
  workerId,
  dataDir,
  intervalMs,
  maxConcurrentHeavyJobs,
  metricIntervalMs: Number(process.env.EVELAND_HOST_METRIC_INTERVAL_MS ?? 60_000),
  onMetricError: (error) =>
    console.warn(
      "Worker host metrics are unavailable:",
      error instanceof Error ? error.message : String(error),
    ),
});
let lastTickDurationMs = 0;
let lastTickError: unknown | null = null;
let telemetryPublishing = false;

function publishTelemetry() {
  if (telemetryPublishing) return;
  telemetryPublishing = true;
  telemetry
    .publishTick({ durationMs: lastTickDurationMs, error: lastTickError })
    .catch((error: unknown) =>
      console.warn(
        "Worker heartbeat is unavailable:",
        error instanceof Error ? error.message : String(error),
      ),
    )
    .finally(() => {
      telemetryPublishing = false;
    });
}

async function tick() {
  return platformObservability.tracer.startActiveSpan(
    "eveland.worker.tick",
    {
      attributes: {
        "eveland.worker.id": workerId,
        "eveland.telemetry.domain": "platform",
      },
    },
    async (span) => {
      const startedAt = Date.now();
      try {
        await Promise.all([
          planDueSchedules(store, {
            limit: Number(process.env.EVELAND_SCHEDULER_PLANNER_BATCH_SIZE ?? 25),
            prewarmMs: schedulerPrewarmMs,
            activationLeaseTtlMs: schedulerPrewarmMs + Math.max(10_000, intervalMs * 2),
          }),
          reapIdleDeployments(store, {
            idleTtlMs: Number(process.env.EVELAND_ACTIVATION_IDLE_TTL_MS ?? 300_000),
            schedulePrewarmMs: schedulerPrewarmMs,
            limit: Number(process.env.EVELAND_ACTIVATION_REAPER_BATCH_SIZE ?? 25),
          }),
          recoverStartingRuntimeInstances(store, {
            limit: Number(process.env.EVELAND_ACTIVATION_RECOVERY_BATCH_SIZE ?? 25),
            staleJobAfterMs: Number(process.env.EVELAND_ACTIVATION_START_STALE_MS ?? 300_000),
          }),
          reconcileRuntimeInstances(store, {
            limit: Number(process.env.EVELAND_ACTIVATION_RECONCILE_BATCH_SIZE ?? 100),
          }),
          reconcileObservability(),
          store.recoverStaleJobs(
            new Date(),
            Number(process.env.WORKER_JOB_STALE_MS ?? 120_000),
            Number(process.env.WORKER_JOB_RECOVERY_BATCH_SIZE ?? 25),
          ),
          store.recoverStaleSourcePreflights(
            new Date(),
            Number(process.env.WORKER_JOB_STALE_MS ?? 120_000),
            Number(process.env.WORKER_JOB_RECOVERY_BATCH_SIZE ?? 25),
          ),
          cleanupExpiredSourcePreflights(store),
        ]);
        lastTickError = null;
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error) {
        lastTickError = error;
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        span.setStatus({ code: SpanStatusCode.ERROR });
        platformObservability.emitLog({
          severity: "error",
          eventName: "eveland.worker.tick.failed",
          body: "Worker control-loop tick failed.",
          attributes: {
            "error.type": error instanceof Error ? error.name : "UnknownError",
          },
        });
        console.error(error);
      } finally {
        lastTickDurationMs = Date.now() - startedAt;
        span.end();
      }
    },
  );
}

// Job admission lives in its own pump, not the control loop: a queued
// activation races Eve's fixed 30-second command-hook wait, and one admission
// per tick caps the whole platform at 12 jobs/minute — a cold-start backlog
// would push session creates past that budget (issue #425's serial lane).
// The pump drains back-to-back with a bounded pool; the tick keeps pacing the
// reconcilers and sweeps only.
const jobPump = startJobPump({
  concurrency: jobConcurrency,
  idleDelayMs: intervalMs,
  claim: () => store.claimNextJob(workerId, undefined, { maxConcurrentHeavyJobs }),
  run: (job) =>
    runClaimedJob(store, job, {
      tracer: platformObservability.tracer,
      maxConcurrentHeavyJobs,
    }),
  onError: (error) => {
    platformObservability.emitLog({
      severity: "error",
      eventName: "eveland.worker.job_pump.failed",
      body: "Worker job pump iteration failed.",
      attributes: {
        "error.type": error instanceof Error ? error.name : "UnknownError",
      },
    });
    console.error(error);
  },
});

// NOTIFY wakes the pump the moment another process enqueues, cutting the
// idle-poll latency out of the session-create path. Purely an optimization:
// on subscription failure the pump's polling continues unchanged, and
// postgres.js re-subscribes lost listener connections on its own (each
// re-subscription fires a wake to cover the gap).
const jobQueueListener = await listenForQueuedJobs(storeFactory.database, () =>
  jobPump.wake(),
).catch((error: unknown) => {
  console.warn(
    "Job-queue NOTIFY listener is unavailable; falling back to queue polling:",
    error instanceof Error ? error.message : String(error),
  );
  return null;
});

// A Git preflight clones and scans inline — minutes-scale on a large repo or
// slow network, the only unbounded work the control loop used to await. Its
// own single-slot pump keeps a slow clone from pausing the reconcilers (the
// tick guard skips overlapping runs) while still draining any preflight
// backlog back-to-back. Repeat-processing safety comes from the DB claim and
// attempt fence, not from serialization with the tick.
const sourcePreflightPump = startJobPump({
  concurrency: 1,
  idleDelayMs: intervalMs,
  claim: () => store.claimNextSourcePreflight(workerId),
  run: (preflight) => runClaimedSourcePreflight(store, preflight),
  onError: (error) => {
    platformObservability.emitLog({
      severity: "error",
      eventName: "eveland.worker.source_preflight_pump.failed",
      body: "Worker source-preflight pump iteration failed.",
      attributes: {
        "error.type": error instanceof Error ? error.name : "UnknownError",
      },
    });
    console.error(error);
  },
});

const runTick = nonOverlapping(tick, (error) => console.error(error), {
  thresholdMs: intervalMs,
  onSlow: (durationMs) => {
    console.warn(
      `Worker control-loop tick took ${durationMs}ms (interval ${intervalMs}ms); overlapping ticks were skipped while it ran.`,
    );
    platformObservability.emitLog({
      severity: "warn",
      eventName: "eveland.worker.tick.slow",
      body: "Worker control-loop tick outlasted its interval; overlapping ticks were skipped.",
      attributes: {
        "eveland.worker.tick.duration_ms": durationMs,
        "eveland.worker.poll_interval_ms": intervalMs,
      },
    });
  },
});
runTick();
publishTelemetry();
const timer = setInterval(runTick, intervalMs);
const telemetryTimer = setInterval(publishTelemetry, intervalMs);

// Separate cadence from tick(): host process listing is comparatively heavy
// and orphan cleanup is not latency-sensitive. Set the interval to 0 to
// disable the sweep entirely.
const reapOrphanProcesses = createOrphanProcessReaper(store, {
  graceMs: Number(process.env.EVELAND_ORPHAN_GRACE_MS ?? 300_000),
});
const sweepOrphans = () => {
  reapOrphanProcesses().catch((error: unknown) =>
    console.error("Orphan process sweep failed:", error),
  );
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
    playgroundIdleTtlMs: Number(process.env.EVELAND_PLAYGROUND_SESSION_IDLE_TTL_MS ?? 86_400_000),
    apiIdleTtlMs: Number(process.env.EVELAND_API_SESSION_IDLE_TTL_MS ?? 604_800_000),
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

// Deployment-scoped on purpose: a run sleeping on a timer or waiting on a
// session inbox hook is the intended durable state for a reaped process, so
// nothing here keys off RuntimeInstance death. Only runs bound to a
// Deployment that can never activate again (missing, archived, or pinned to
// an out-of-window Eve) are settled. Set the interval to 0 to disable.
const sweepAbandonedWorkflowRuns = () => {
  reconcileAbandonedWorkflowRuns(store).catch((error: unknown) =>
    console.error(
      "Abandoned workflow-run reconciliation failed:",
      error instanceof Error ? error.message : String(error),
    ),
  );
};
let workflowRunReconcileTimer: NodeJS.Timeout | undefined;
if (workflowRunReconcileIntervalMs > 0) {
  sweepAbandonedWorkflowRuns();
  workflowRunReconcileTimer = setInterval(
    sweepAbandonedWorkflowRuns,
    workflowRunReconcileIntervalMs,
  );
}

const workflowRetentionScheduler = startWorkflowStreamRetentionScheduler({
  intervalMs: workflowSweepIntervalMs,
  run: async () => {
    await runWorkflowStreamRetentionSweep({
      sweepLegacy: () =>
        sweepWorkflowStreamRetention(process.env, {
          retentionMs: Number(process.env.EVELAND_WORKFLOW_STREAM_RETENTION_MS ?? 86_400_000),
          batchSize: Number(process.env.EVELAND_WORKFLOW_SWEEP_BATCH_SIZE ?? 50_000),
        }),
      onSummary(summary) {
        const formatted = formatWorkflowStreamRetentionSummary(summary);
        console[formatted.level](formatted.message);
        platformObservability.emitLog({
          severity: formatted.level,
          eventName: "eveland.worker.workflow_stream_retention.sweep",
          body: formatted.message,
          attributes: formatted.attributes,
        });
      },
    });
  },
  onError: (error) =>
    console.error(
      "Workflow stream retention scheduler failed:",
      error instanceof Error ? error.name : "UnknownError",
    ),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearInterval(timer);
    clearInterval(telemetryTimer);
    if (orphanTimer) clearInterval(orphanTimer);
    if (releaseTimer) clearInterval(releaseTimer);
    if (workflowRunReconcileTimer) clearInterval(workflowRunReconcileTimer);
    // Blocks new claims and wakes idle loops; in-flight jobs are not awaited
    // (they die with the process and are later recovered as stale), matching
    // the pre-pump shutdown behavior.
    void jobPump.stop();
    void sourcePreflightPump.stop();
    void Promise.all([
      jobQueueListener?.close() ?? Promise.resolve(),
      storeFactory.close(),
      workflowRetentionScheduler.close(),
      capacityObservability.shutdown(),
      platformObservability.shutdown(),
      runtimeObservability.shutdown(),
    ]).finally(() => process.exit(0));
  });
}
