import { createId } from "@evelandhq/core/ids";
import { and, asc, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import {
  activationLeaseRowToActivationLease,
  runtimeInstanceRowToRuntimeInstance,
} from "./mappers.js";
import { activationLeases, deployments, runtimeInstances, workflowFences } from "./schema.js";
import { isUniqueConstraint } from "./postgres-store-support.js";
import { RuntimeInstanceDrainingError } from "./store-shared.js";
import type { RuntimeStore } from "./store-domains.js";
import type { PostgresStoreContext } from "./postgres-store-support.js";

export function createPostgresRuntimeStore({ db }: PostgresStoreContext): RuntimeStore {
  return {
    async acquireActivationLease(input) {
      return db.transaction(async (tx) => {
        const [deployment] = await tx
          .select({ id: deployments.id })
          .from(deployments)
          .where(eq(deployments.id, input.deploymentId))
          .limit(1)
          .for("update");
        if (!deployment) throw new Error("Cannot activate an unknown Deployment.");
        // A terminal fence written by a cutover/termination operation blocks
        // every wake path — public request, stream, turn, workflow step and
        // schedule alike — until an operator explicitly resolves it.
        const [fence] = await tx
          .select({ operationId: workflowFences.operationId, reason: workflowFences.reason })
          .from(workflowFences)
          .where(
            and(
              eq(workflowFences.scopeKind, "deployment"),
              eq(workflowFences.scopeId, input.deploymentId),
              isNull(workflowFences.resolvedAt),
            ),
          )
          .limit(1);
        if (fence) {
          throw new Error(
            `workflow_unavailable: Deployment ${input.deploymentId} is fenced by operation ${fence.operationId} (${fence.reason}).`,
          );
        }
        const now = input.now ?? new Date();
        const [latestRuntimeInstance] = await tx
          .select()
          .from(runtimeInstances)
          .where(eq(runtimeInstances.deploymentId, input.deploymentId))
          .orderBy(desc(runtimeInstances.generation))
          .limit(1)
          .for("update");
        if (latestRuntimeInstance?.status === "draining") {
          throw new RuntimeInstanceDrainingError();
        }
        let runtimeInstance =
          latestRuntimeInstance &&
          (latestRuntimeInstance.status === "starting" || latestRuntimeInstance.status === "ready")
            ? latestRuntimeInstance
            : undefined;
        const starter = !runtimeInstance;
        if (!runtimeInstance) {
          const [latest] = await tx
            .select({ generation: runtimeInstances.generation })
            .from(runtimeInstances)
            .where(eq(runtimeInstances.deploymentId, input.deploymentId))
            .orderBy(desc(runtimeInstances.generation))
            .limit(1);
          [runtimeInstance] = await tx
            .insert(runtimeInstances)
            .values({
              id: createId("rti"),
              deploymentId: input.deploymentId,
              generation: (latest?.generation ?? 0) + 1,
              status: "starting",
              startedAt: now,
            })
            .returning();
        }
        if (!runtimeInstance) throw new Error("Failed to create RuntimeInstance.");
        const [lease] = await tx
          .insert(activationLeases)
          .values({
            id: createId("lease"),
            deploymentId: input.deploymentId,
            runtimeInstanceId: runtimeInstance.id,
            kind: input.kind,
            ownerId: input.ownerId,
            expiresAt: input.expiresAt,
          })
          .onConflictDoUpdate({
            target: [
              activationLeases.deploymentId,
              activationLeases.kind,
              activationLeases.ownerId,
            ],
            set: {
              runtimeInstanceId: runtimeInstance.id,
              expiresAt: input.expiresAt,
              releasedAt: null,
            },
          })
          .returning();
        if (!lease) throw new Error("Failed to create ActivationLease.");
        return {
          lease: activationLeaseRowToActivationLease(lease),
          runtimeInstance: runtimeInstanceRowToRuntimeInstance(runtimeInstance),
          starter,
        };
      });
    },

    async getRuntimeInstance(runtimeInstanceId) {
      const [row] = await db
        .select()
        .from(runtimeInstances)
        .where(eq(runtimeInstances.id, runtimeInstanceId))
        .limit(1);
      return row ? runtimeInstanceRowToRuntimeInstance(row) : null;
    },

    async listDeploymentRuntimeInstances(deploymentId) {
      const rows = await db
        .select()
        .from(runtimeInstances)
        .where(eq(runtimeInstances.deploymentId, deploymentId))
        .orderBy(asc(runtimeInstances.generation));
      return rows.map(runtimeInstanceRowToRuntimeInstance);
    },

    async adoptRuntimeInstance(deploymentId, endpoint, now = new Date()) {
      try {
        return await db.transaction(async (tx) => {
          // Same deployment-level lock acquireActivationLease takes, so adoption
          // and activation serialize on the runtime_instances generation chain
          // instead of racing to insert the same generation.
          const [deployment] = await tx
            .select({ id: deployments.id })
            .from(deployments)
            .where(eq(deployments.id, deploymentId))
            .limit(1)
            .for("update");
          if (!deployment) return null;
          const [latest] = await tx
            .select()
            .from(runtimeInstances)
            .where(eq(runtimeInstances.deploymentId, deploymentId))
            .orderBy(desc(runtimeInstances.generation))
            .limit(1)
            .for("update");
          if (
            latest &&
            (latest.status === "starting" ||
              latest.status === "ready" ||
              latest.status === "draining")
          ) {
            return null;
          }
          const [row] = await tx
            .insert(runtimeInstances)
            .values({
              id: createId("rti"),
              deploymentId,
              generation: (latest?.generation ?? 0) + 1,
              status: "ready",
              endpointHost: endpoint.endpointHost,
              endpointPort: endpoint.endpointPort,
              startedAt: now,
              readyAt: now,
            })
            .returning();
          return row ? runtimeInstanceRowToRuntimeInstance(row) : null;
        });
      } catch (error) {
        // Another live instance already reserved this port: the orphan is a
        // duplicate claimant, not adoptable. Callers treat null as "leave it
        // to the stop path", matching the existing already-owned contract.
        if (isUniqueConstraint(error, "runtime_instances_live_port_idx")) return null;
        throw error;
      }
    },

    async listRuntimeInstances(statuses, limit) {
      if (!Number.isInteger(limit) || limit < 1)
        throw new Error("RuntimeInstance list limit must be positive.");
      if (statuses.length === 0) return [];
      // Recency first: dead rows are never pruned, so a bounded sweep over a
      // creation-ordered list fills its window with old deaths and never
      // reaches a freshly stopped instance -- whose observed Sessions then
      // wedge until an unrelated redeploy (#270). Live statuses have no
      // stoppedAt and keep the stable creation order.
      const rows = await db
        .select()
        .from(runtimeInstances)
        .where(or(...statuses.map((status) => eq(runtimeInstances.status, status))))
        .orderBy(
          sql`${runtimeInstances.stoppedAt} desc nulls last`,
          asc(runtimeInstances.deploymentId),
          asc(runtimeInstances.generation),
        )
        .limit(limit);
      return rows.map(runtimeInstanceRowToRuntimeInstance);
    },

    async updateRuntimeInstance(runtimeInstanceId, input, now = new Date()) {
      const [row] = await db
        .update(runtimeInstances)
        .set({
          status: input.status,
          ...(input.endpointHost !== undefined ? { endpointHost: input.endpointHost } : {}),
          ...(input.endpointPort !== undefined ? { endpointPort: input.endpointPort } : {}),
          ...(input.error !== undefined ? { lastError: input.error } : {}),
          ...(input.status === "ready" ? { readyAt: now } : {}),
          ...(input.status === "stopped" || input.status === "failed" ? { stoppedAt: now } : {}),
        })
        .where(eq(runtimeInstances.id, runtimeInstanceId))
        .returning();
      return row ? runtimeInstanceRowToRuntimeInstance(row) : null;
    },

    async reserveRuntimeInstancePort(runtimeInstanceId, port) {
      try {
        const [row] = await db
          .update(runtimeInstances)
          .set({ endpointHost: "127.0.0.1", endpointPort: port })
          .where(eq(runtimeInstances.id, runtimeInstanceId))
          .returning({ id: runtimeInstances.id });
        return Boolean(row);
      } catch (error) {
        if (isUniqueConstraint(error, "runtime_instances_live_port_idx")) return false;
        throw error;
      }
    },

    async getActivationLease(leaseId) {
      const [row] = await db
        .select()
        .from(activationLeases)
        .where(eq(activationLeases.id, leaseId))
        .limit(1);
      return row ? activationLeaseRowToActivationLease(row) : null;
    },

    async renewActivationLease(leaseId, expiresAt, now = new Date()) {
      const [row] = await db
        .update(activationLeases)
        .set({ expiresAt })
        .where(
          and(
            eq(activationLeases.id, leaseId),
            isNull(activationLeases.releasedAt),
            gt(activationLeases.expiresAt, now),
          ),
        )
        .returning();
      return row ? activationLeaseRowToActivationLease(row) : null;
    },

    async releaseActivationLease(leaseId, now = new Date()) {
      const [row] = await db
        .update(activationLeases)
        .set({ releasedAt: now })
        .where(and(eq(activationLeases.id, leaseId), isNull(activationLeases.releasedAt)))
        .returning();
      if (row) return activationLeaseRowToActivationLease(row);
      const [existing] = await db
        .select()
        .from(activationLeases)
        .where(eq(activationLeases.id, leaseId))
        .limit(1);
      return existing ? activationLeaseRowToActivationLease(existing) : null;
    },

    async hasActiveActivationLeases(deploymentId, now = new Date()) {
      const [row] = await db
        .select({ id: activationLeases.id })
        .from(activationLeases)
        .where(
          and(
            eq(activationLeases.deploymentId, deploymentId),
            isNull(activationLeases.releasedAt),
            gt(activationLeases.expiresAt, now),
          ),
        )
        .limit(1);
      return Boolean(row);
    },

    async claimIdleRuntimeInstances(input) {
      if (!Number.isInteger(input.limit) || input.limit < 1)
        throw new Error("Runtime idle claim limit must be positive.");
      if (!Number.isFinite(input.idleTtlMs) || input.idleTtlMs < 0)
        throw new Error("Runtime idle TTL must be non-negative.");
      const schedulePrewarmMs = input.schedulePrewarmMs ?? 0;
      if (!Number.isFinite(schedulePrewarmMs) || schedulePrewarmMs < 0) {
        throw new Error("Schedule prewarm window must be non-negative.");
      }
      return db.transaction(async (tx) => {
        const cutoffAt = new Date(input.now.getTime() - input.idleTtlMs);
        const scheduleHorizon = new Date(input.now.getTime() + schedulePrewarmMs);
        const candidates = await tx
          .select()
          .from(runtimeInstances)
          .where(
            or(
              eq(runtimeInstances.status, "draining"),
              and(
                eq(runtimeInstances.status, "ready"),
                sql`not exists (
                select 1 from activation_leases as active_lease
                where active_lease.deployment_id = ${runtimeInstances.deploymentId}
                  and active_lease.released_at is null
                  and active_lease.expires_at > ${input.now.toISOString()}::timestamptz
              )`,
                sql`not exists (
                select 1 from schedule_runs as protected_run
                where protected_run.deployment_id = ${runtimeInstances.deploymentId}
                  and protected_run.status in ('queued', 'activating', 'dispatching', 'running')
              )`,
                ...(schedulePrewarmMs > 0
                  ? [
                      sql`not exists (
                  select 1
                  from project_scheduler_targets as protected_target
                  join project_schedules as upcoming_schedule
                    on upcoming_schedule.project_id = protected_target.project_id
                  where protected_target.deployment_id = ${runtimeInstances.deploymentId}
                    and upcoming_schedule.enabled = true
                    and upcoming_schedule.next_run_at is not null
                    and upcoming_schedule.next_run_at <= ${scheduleHorizon.toISOString()}::timestamptz
                )`,
                    ]
                  : []),
                sql`greatest(
                coalesce(${runtimeInstances.readyAt}, ${runtimeInstances.startedAt}, '-infinity'::timestamptz),
                coalesce((
                  select max(coalesce(instance_lease.released_at, instance_lease.expires_at))
                  from activation_leases as instance_lease
                  where instance_lease.runtime_instance_id = ${runtimeInstances.id}
                ), '-infinity'::timestamptz)
              ) <= ${cutoffAt.toISOString()}::timestamptz`,
              ),
            ),
          )
          .orderBy(asc(runtimeInstances.deploymentId), asc(runtimeInstances.generation))
          .limit(input.limit)
          .for("update", { skipLocked: true });
        const claimed = [];
        for (const candidate of candidates) {
          if (candidate.status === "draining") {
            claimed.push(runtimeInstanceRowToRuntimeInstance(candidate));
            continue;
          }
          const [activeLease] = await tx
            .select({ id: activationLeases.id })
            .from(activationLeases)
            .where(
              and(
                eq(activationLeases.deploymentId, candidate.deploymentId),
                isNull(activationLeases.releasedAt),
                gt(activationLeases.expiresAt, input.now),
              ),
            )
            .limit(1);
          if (activeLease) continue;
          const leaseRows = await tx
            .select({
              expiresAt: activationLeases.expiresAt,
              releasedAt: activationLeases.releasedAt,
            })
            .from(activationLeases)
            .where(eq(activationLeases.runtimeInstanceId, candidate.id));
          const activityTimes = [candidate.readyAt, candidate.startedAt]
            .concat(leaseRows.map((lease) => lease.releasedAt ?? lease.expiresAt))
            .filter((value): value is Date => value !== null)
            .map((value) => value.getTime());
          if (Math.max(...activityTimes) > cutoffAt.getTime()) continue;
          const [updated] = await tx
            .update(runtimeInstances)
            .set({ status: "draining" })
            .where(and(eq(runtimeInstances.id, candidate.id), eq(runtimeInstances.status, "ready")))
            .returning();
          if (updated) claimed.push(runtimeInstanceRowToRuntimeInstance(updated));
        }
        return claimed;
      });
    },
  };
}
