import { randomUUID } from "node:crypto";
import os from "node:os";
import type {
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
  });

  const apiUrl = apiUrlForActivation;
  const activationToken = env.WORKFLOW_DISPATCHER_ACTIVATION_TOKEN ?? "eveland-dev-gateway-token";

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
