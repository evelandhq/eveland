import { randomUUID } from "node:crypto";
import os from "node:os";
import type {
  DispatcherLifecycleEvent,
  DispatcherService,
  DispatcherServiceOptions,
  DispatcherTelemetry,
} from "@evelandhq/workflow-world/dispatcher";
import {
  countClaimableUnscopedFlowJobs,
  DISPATCH_VERSION,
  listUnresolvedRunQuarantines,
} from "@evelandhq/workflow-world";

/** The pg pool type as workflow-world exposes it; this app has no pg dependency. */
type WorldPool = Parameters<typeof countClaimableUnscopedFlowJobs>[0];

/**
 * eveland's composition of the workflow dispatcher:
 *
 * - `recover-paused` start mode (`EVELAND_WORKFLOW_DISPATCHER_START_MODE`)
 *   finishes ownership, migrations and boot recovery but claims nothing until
 *   the control plane's authenticated resume arrives via the heartbeat reply;
 * - every lifecycle transition is reported machine-readably to the Control API
 *   as a registration heartbeat — the stdout token stays purely informational;
 * - the cutover preflight fails startup closed while any early-external job is
 *   still claimable outside a per-run queue.
 *
 * The registration deliberately carries the database *identity*
 * (host:port/name), never the URL: the readiness surface must not be able to
 * leak credentials.
 */

export const DISPATCHER_READY_TOKEN = "workflow-dispatcher: ready";

export type DispatcherRunnerDeps = {
  startService: (options: DispatcherServiceOptions) => Promise<DispatcherService>;
  fetchImplementation: typeof fetch;
  countUnscopedJobs: (pool: WorldPool) => Promise<number>;
  countUnresolvedQuarantines: (pool: WorldPool) => Promise<number>;
  readSchemaGeneration: (pool: WorldPool) => Promise<string | null>;
  now: () => Date;
};

export type DispatcherRunnerHandle = {
  service: DispatcherService;
  /** One heartbeat: report state, apply the returned desired state. */
  heartbeat(): Promise<void>;
  stop(): Promise<void>;
};

export function worldDatabaseIdentity(worldUrl: string): string {
  try {
    const url = new URL(worldUrl);
    return `${url.hostname}:${url.port || "5432"}${url.pathname || ""}`;
  } catch {
    return "unknown";
  }
}

export async function startEvelandWorkflowDispatcher(
  env: NodeJS.ProcessEnv,
  telemetry: DispatcherTelemetry,
  deps: DispatcherRunnerDeps,
): Promise<DispatcherRunnerHandle> {
  const instanceId = `wfd_${os.hostname()}_${String(process.pid)}_${randomUUID().slice(0, 8)}`;
  const generation = `eveland-workflow-dispatcher ${env.EVELAND_REVISION ?? "dev"}`;
  const startPaused = env.EVELAND_WORKFLOW_DISPATCHER_START_MODE === "recover-paused";

  const snapshot = {
    ownershipAcquired: false,
    bootRecoveryCompleted: false,
    reenqueuedRuns: null as number | null,
    unscopedRunnableJobs: null as number | null,
    unresolvedQuarantines: null as number | null,
    schemaGeneration: null as string | null,
    state: "recovering" as
      | "recovering"
      | "ready_paused"
      | "ready"
      | "draining"
      | "failed"
      | "stopped",
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
      case "ready_paused":
        snapshot.state = "ready_paused";
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

  const service = await deps.startService({
    env,
    telemetry,
    startPaused,
    lifecycle: { onPhase },
    async beforeBootRecovery({ pool }) {
      const [unscoped, quarantines, schemaGeneration] = await Promise.all([
        deps.countUnscopedJobs(pool),
        deps.countUnresolvedQuarantines(pool),
        deps.readSchemaGeneration(pool),
      ]);
      snapshot.unscopedRunnableJobs = unscoped;
      snapshot.unresolvedQuarantines = quarantines;
      snapshot.schemaGeneration = schemaGeneration;
      if (unscoped > 0) {
        throw new Error(
          `${String(unscoped)} early-external job(s) are still claimable outside a per-run queue. ` +
            "Run the cutover job migration before starting the dispatcher; boot recovery must not race them.",
        );
      }
    },
  });

  const apiUrl = (env.WORKFLOW_DISPATCHER_ACTIVATION_API_URL ?? "").replace(/\/+$/u, "");
  const activationToken = env.WORKFLOW_DISPATCHER_ACTIVATION_TOKEN ?? "eveland-dev-gateway-token";
  const identity = worldDatabaseIdentity(service.config.worldUrl);

  const heartbeat = async () => {
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
            worldDatabaseIdentity: identity,
            schemaGeneration: snapshot.schemaGeneration,
            protocolMin: DISPATCH_VERSION,
            protocolMax: DISPATCH_VERSION,
            cutoverOperationId: env.EVELAND_WORKFLOW_CUTOVER_OPERATION_ID ?? null,
            unscopedRunnableJobs: snapshot.unscopedRunnableJobs,
            unresolvedQuarantines: snapshot.unresolvedQuarantines,
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
      const body = (await response.json().catch(() => null)) as {
        desiredState?: string;
      } | null;
      // The authenticated resume: the control plane flips the desired state,
      // and this — never a process restart — is what starts claiming.
      if (body?.desiredState === "ready" && service.phase === "ready_paused") {
        await service.resume();
      }
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

  // First report immediately so a paused dispatcher is visible to operators
  // before the first interval elapses.
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

export const defaultRunnerDeps: Omit<DispatcherRunnerDeps, "startService"> = {
  fetchImplementation: fetch,
  countUnscopedJobs: countClaimableUnscopedFlowJobs,
  countUnresolvedQuarantines: async (pool) => (await listUnresolvedRunQuarantines(pool)).length,
  readSchemaGeneration: readLatestSchemaGeneration,
  now: () => new Date(),
};
