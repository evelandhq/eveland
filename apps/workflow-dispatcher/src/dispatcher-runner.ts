import { randomUUID } from "node:crypto";
import os from "node:os";
import type {
  BootRecoveryRun,
  DispatcherLifecycleEvent,
  DispatcherService,
  DispatcherServiceOptions,
  DispatcherTelemetry,
} from "@evelandhq/workflow-world/dispatcher";
import { clusterWorldIdentity, WORLD_IDENTITY_SQL } from "@evelandhq/core/workflow-dispatch";
import { createActivationClient } from "@evelandhq/workflow-world/dispatcher";
import { DISPATCH_VERSION } from "@evelandhq/workflow-world";

/** The pg pool type as workflow-world exposes it; this app has no pg dependency. */
type WorldPool = Parameters<NonNullable<DispatcherServiceOptions["beforeBootRecovery"]>>[0]["pool"];

/**
 * eveland's composition of the workflow dispatcher: every lifecycle
 * transition is reported machine-readably to the Control API as a
 * registration heartbeat — the stdout token stays purely informational.
 *
 * The registration deliberately carries the database *identity*
 * (`cluster:<system_identifier>/<database>`, read from the database itself),
 * never the URL: the readiness surface must not be able to leak credentials.
 */

export const DISPATCHER_READY_TOKEN = "workflow-dispatcher: ready";

export type DispatcherRunnerDeps = {
  startService: (options: DispatcherServiceOptions) => Promise<DispatcherService>;
  fetchImplementation: typeof fetch;
  readSchemaGeneration: (pool: WorldPool) => Promise<string | null>;
  /** `cluster:<system_identifier>/<database>` from the connected database itself. */
  readWorldIdentity: (pool: WorldPool) => Promise<string>;
  now: () => Date;
};

export type DispatcherRunnerHandle = {
  service: DispatcherService;
  /** One heartbeat: report the current state to the Control API. */
  heartbeat(): Promise<void>;
  stop(): Promise<void>;
};

export async function startEvelandWorkflowDispatcher(
  env: NodeJS.ProcessEnv,
  telemetry: DispatcherTelemetry,
  deps: DispatcherRunnerDeps,
): Promise<DispatcherRunnerHandle> {
  const instanceId = `wfd_${os.hostname()}_${String(process.pid)}_${randomUUID().slice(0, 8)}`;
  const generation = `eveland-workflow-dispatcher ${env.EVELAND_REVISION ?? "dev"}`;

  const snapshot = {
    ownershipAcquired: false,
    bootRecoveryCompleted: false,
    reenqueuedRuns: null as number | null,
    schemaGeneration: null as string | null,
    worldIdentity: "unknown",
    state: "recovering" as "recovering" | "ready" | "draining" | "failed" | "stopped",
    startedAt: deps.now().toISOString(),
    readyAt: null as string | null,
  };

  const onPhase = (event: DispatcherLifecycleEvent) => {
    switch (event.phase) {
      case "ownership_acquired":
        snapshot.ownershipAcquired = true;
        break;
      case "boot_recovery_completed":
        snapshot.bootRecoveryCompleted = true;
        snapshot.reenqueuedRuns =
          typeof event.attributes?.reenqueuedRuns === "number"
            ? event.attributes.reenqueuedRuns
            : null;
        break;
      case "ready":
        snapshot.state = "ready";
        snapshot.readyAt = deps.now().toISOString();
        // The one supervisor-visible line; gating happens on the registration.
        console.log(DISPATCHER_READY_TOKEN);
        break;
      case "stopped":
        snapshot.state = "stopped";
        break;
      default:
        break;
    }
  };

  const apiUrlForActivation = (env.WORKFLOW_DISPATCHER_ACTIVATION_API_URL ?? "").replace(
    /\/+$/u,
    "",
  );
  const activationToken = env.WORKFLOW_DISPATCHER_ACTIVATION_TOKEN ?? "eveland-dev-gateway-token";

  /**
   * Boot-recovery filter (issue #433): ask the control plane which of the
   * candidates' Deployments can never activate again, and leave those runs
   * out of the sweep — each one re-enqueued is a guaranteed dead letter per
   * restart. One batched call, because the candidate list arrives whole.
   * Every failure path fails open to the full list: replaying a doomed run is
   * the pre-#433 status quo, while wrongly skipping a healthy one would
   * silently strand it until the next boot.
   */
  const filterBootRecoveryRuns = async (runs: BootRecoveryRun[]): Promise<BootRecoveryRun[]> => {
    if (!apiUrlForActivation || runs.length === 0) return runs;
    try {
      const deploymentIds = [...new Set(runs.map((run) => run.deploymentId))];
      const response = await deps.fetchImplementation(
        `${apiUrlForActivation}/internal/workflow/dispatcher/recovery-preflight`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${activationToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ deploymentIds }),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        telemetry.emit({
          severity: "warn",
          eventName: "workflow_dispatcher.recovery_preflight_rejected",
          body: `recovery preflight rejected with HTTP ${String(response.status)}; recovering all candidates`,
        });
        return runs;
      }
      const payload = (await response.json()) as {
        notActivatable?: { deploymentId: string; reason: string }[];
      };
      const refused = new Map(
        (payload.notActivatable ?? []).map((entry) => [entry.deploymentId, entry.reason]),
      );
      if (refused.size === 0) return runs;
      const kept = runs.filter((run) => !refused.has(run.deploymentId));
      for (const [deploymentId, reason] of refused) {
        telemetry.emit({
          severity: "info",
          eventName: "workflow_dispatcher.recovery_skipped_deployment",
          body: `boot recovery skipped runs bound to ${deploymentId}: ${reason}`,
          attributes: {
            "eveland.deployment.id": deploymentId,
            "dispatcher.skipped_runs": runs.length - kept.length,
          },
        });
      }
      return kept;
    } catch (error) {
      telemetry.emit({
        severity: "warn",
        eventName: "workflow_dispatcher.recovery_preflight_failed",
        body: `recovery preflight failed; recovering all candidates: ${String(error)}`,
      });
      return runs;
    }
  };

  const service = await deps.startService({
    env,
    telemetry,
    lifecycle: { onPhase },
    // Exact activation is bound to THIS registration: the client sends the
    // instance id on every activation, and the control plane matches it to the
    // registration it validated before selecting a protocol.
    ...(apiUrlForActivation
      ? {
          activation: createActivationClient({
            apiUrl: apiUrlForActivation,
            serviceToken: env.WORKFLOW_DISPATCHER_ACTIVATION_TOKEN ?? "eveland-dev-gateway-token",
            instanceId,
          }),
        }
      : {}),
    async beforeBootRecovery({ pool }) {
      const [schemaGeneration, worldIdentity] = await Promise.all([
        deps.readSchemaGeneration(pool),
        deps.readWorldIdentity(pool),
      ]);
      snapshot.schemaGeneration = schemaGeneration;
      snapshot.worldIdentity = worldIdentity;
    },
    filterBootRecoveryRuns,
  });

  const apiUrl = apiUrlForActivation;

  const heartbeat = async () => {
    emitCapacitySnapshot(service, telemetry);
    if (!apiUrl) return;
    try {
      const response = await deps.fetchImplementation(
        `${apiUrl}/internal/workflow/dispatcher/heartbeat`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${activationToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            instanceId,
            generation,
            state: service.phase === "stopped" ? "stopped" : snapshot.state,
            ownershipAcquired: snapshot.ownershipAcquired,
            bootRecoveryCompleted: snapshot.bootRecoveryCompleted,
            reenqueuedRuns: snapshot.reenqueuedRuns,
            worldDatabaseIdentity: snapshot.worldIdentity,
            schemaGeneration: snapshot.schemaGeneration,
            protocolMin: DISPATCH_VERSION,
            protocolMax: DISPATCH_VERSION,
            startedAt: snapshot.startedAt,
            readyAt: snapshot.readyAt,
          }),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        telemetry.emit({
          severity: "warn",
          eventName: "workflow_dispatcher.heartbeat_rejected",
          body: `registration heartbeat rejected with HTTP ${String(response.status)}`,
        });
        return;
      }
      await response.body?.cancel();
    } catch (error) {
      // Observability/control-plane failure isolation: a failed heartbeat is
      // reported, never fatal to in-flight dispatch work.
      telemetry.emit({
        severity: "warn",
        eventName: "workflow_dispatcher.heartbeat_failed",
        body: String(error),
      });
    }
  };

  // First report immediately so the dispatcher is visible to operators before
  // the first interval elapses.
  await heartbeat();

  return {
    service,
    heartbeat,
    async stop() {
      await service.stop();
      snapshot.state = "stopped";
      await heartbeat();
    },
  };
}

function emitCapacitySnapshot(service: DispatcherService, telemetry: DispatcherTelemetry): void {
  const byTenant = service.runtime?.fairness.snapshot() ?? {};
  const inFlight = Object.values(byTenant).reduce((total, count) => total + count, 0);
  const saturated = Object.entries(byTenant).filter(
    ([, count]) => count >= service.config.maxInFlightPerTenant,
  );
  try {
    telemetry.emit({
      severity: "info",
      eventName: "workflow_dispatcher.capacity",
      body: "workflow dispatcher capacity snapshot",
      attributes: {
        "dispatcher.in_flight": inFlight,
        "dispatcher.concurrency": service.config.concurrency,
        "dispatcher.available": Math.max(0, service.config.concurrency - inFlight),
        "dispatcher.max_in_flight_per_tenant": service.config.maxInFlightPerTenant,
        "dispatcher.saturated_tenants": saturated.length,
      },
    });
    for (const [tenantId, tenantInFlight] of saturated) {
      telemetry.emit({
        severity: "warn",
        eventName: "workflow_dispatcher.tenant_saturated",
        body: "tenant reached the workflow dispatcher in-flight cap",
        attributes: {
          "eveland.project.id": tenantId,
          "dispatcher.tenant.in_flight": tenantInFlight,
          "dispatcher.max_in_flight_per_tenant": service.config.maxInFlightPerTenant,
          "dispatcher.in_flight": inFlight,
          "dispatcher.concurrency": service.config.concurrency,
        },
      });
    }
  } catch {
    // Telemetry must never make the dispatcher heartbeat or claim loop fail.
  }
}

export function resolveHeartbeatIntervalMs(env: NodeJS.ProcessEnv): number {
  const parsed = Number.parseInt(env.EVELAND_WORKFLOW_DISPATCHER_HEARTBEAT_INTERVAL_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15_000;
}

export async function readLatestSchemaGeneration(pool: WorldPool): Promise<string | null> {
  try {
    const { rows } = await pool.query<{ name: string }>(
      "select name from workflow.eveland_migrations order by name desc limit 1",
    );
    return rows[0]?.name ?? null;
  } catch {
    return null;
  }
}

export async function readWorldClusterIdentity(pool: WorldPool): Promise<string> {
  try {
    const { rows } = await pool.query<{ system_identifier: string; database: string }>(
      WORLD_IDENTITY_SQL,
    );
    const row = rows[0];
    if (!row) return "unknown";
    return clusterWorldIdentity(row.system_identifier, row.database);
  } catch {
    // "unknown" never satisfies the readiness gate — fail closed, not open.
    return "unknown";
  }
}

export const defaultRunnerDeps: Omit<DispatcherRunnerDeps, "startService"> = {
  fetchImplementation: fetch,
  readSchemaGeneration: readLatestSchemaGeneration,
  readWorldIdentity: readWorldClusterIdentity,
  now: () => new Date(),
};
