import type { RuntimeInstance } from "@eveland/core/contracts";
import { createId } from "@eveland/core/ids";
import type { MemoryState } from "./memory-state.js";
import type { MemoryDomain } from "./memory-store-support.js";
import type { RuntimeStore } from "./store-domains.js";
import { RuntimeInstanceDrainingError } from "./store-shared.js";

export function createMemoryRuntimeStore(state: MemoryState): MemoryDomain<RuntimeStore> {
  return {
    async acquireActivationLease(input) {
      const deployment = state.deployments.find((candidate) => candidate.id === input.deploymentId);
      if (!deployment) throw new Error("Cannot activate an unknown Deployment.");
      const now = input.now ?? new Date();
      const nowIso = now.toISOString();
      const latestRuntimeInstance = state.runtimeInstances
        .filter((candidate) => candidate.deploymentId === input.deploymentId)
        .sort((a, b) => b.generation - a.generation)[0];
      if (latestRuntimeInstance?.status === "draining") {
        throw new RuntimeInstanceDrainingError();
      }
      let runtimeInstance = latestRuntimeInstance &&
        (latestRuntimeInstance.status === "starting" || latestRuntimeInstance.status === "ready")
        ? latestRuntimeInstance
        : undefined;
      const starter = !runtimeInstance;
      if (!runtimeInstance) {
        const generation = Math.max(
          0,
          ...state.runtimeInstances
            .filter((candidate) => candidate.deploymentId === input.deploymentId)
            .map((candidate) => candidate.generation),
        ) + 1;
        runtimeInstance = {
          id: createId("rti"),
          deploymentId: input.deploymentId,
          generation,
          status: "starting",
          endpointHost: null,
          endpointPort: null,
          startedAt: nowIso,
          readyAt: null,
          stoppedAt: null,
          lastError: null,
        };
        state.runtimeInstances.push(runtimeInstance);
      }
      let lease = state.activationLeases.find(
        (candidate) =>
          candidate.deploymentId === input.deploymentId &&
          candidate.kind === input.kind &&
          candidate.ownerId === input.ownerId,
      );
      if (lease) {
        lease.runtimeInstanceId = runtimeInstance.id;
        lease.expiresAt = input.expiresAt.toISOString();
        lease.releasedAt = null;
      } else {
        lease = {
          id: createId("lease"),
          deploymentId: input.deploymentId,
          runtimeInstanceId: runtimeInstance.id,
          kind: input.kind,
          ownerId: input.ownerId,
          expiresAt: input.expiresAt.toISOString(),
          releasedAt: null,
        };
        state.activationLeases.push(lease);
      }
      return { lease, runtimeInstance, starter };
    },

    async getRuntimeInstance(runtimeInstanceId) {
      return state.runtimeInstances.find((candidate) => candidate.id === runtimeInstanceId) ?? null;
    },

    async listDeploymentRuntimeInstances(deploymentId) {
      return state.runtimeInstances
        .filter((candidate) => candidate.deploymentId === deploymentId)
        .sort((a, b) => a.generation - b.generation);
    },

    async adoptRuntimeInstance(deploymentId, endpoint, now = new Date()) {
      const deployment = state.deployments.find((candidate) => candidate.id === deploymentId);
      if (!deployment) return null;
      const latest = state.runtimeInstances
        .filter((candidate) => candidate.deploymentId === deploymentId)
        .sort((a, b) => b.generation - a.generation)[0];
      if (latest && (latest.status === "starting" || latest.status === "ready" || latest.status === "draining")) {
        return null;
      }
      const nowIso = now.toISOString();
      const instance: RuntimeInstance = {
        id: createId("rti"),
        deploymentId,
        generation: (latest?.generation ?? 0) + 1,
        status: "ready",
        endpointHost: endpoint.endpointHost,
        endpointPort: endpoint.endpointPort,
        startedAt: nowIso,
        readyAt: nowIso,
        stoppedAt: null,
        lastError: null,
      };
      state.runtimeInstances.push(instance);
      return instance;
    },

    async listRuntimeInstances(statuses, limit) {
      if (!Number.isInteger(limit) || limit < 1) throw new Error("RuntimeInstance list limit must be positive.");
      const allowed = new Set(statuses);
      return state.runtimeInstances
        .filter((candidate) => allowed.has(candidate.status))
        .sort((a, b) => a.deploymentId.localeCompare(b.deploymentId) || a.generation - b.generation)
        .slice(0, limit);
    },

    async updateRuntimeInstance(runtimeInstanceId, input, now = new Date()) {
      const instance = state.runtimeInstances.find((candidate) => candidate.id === runtimeInstanceId);
      if (!instance) return null;
      instance.status = input.status;
      if (input.endpointHost !== undefined) instance.endpointHost = input.endpointHost;
      if (input.endpointPort !== undefined) instance.endpointPort = input.endpointPort;
      if (input.error !== undefined) instance.lastError = input.error;
      if (input.status === "ready") instance.readyAt = now.toISOString();
      if (input.status === "stopped" || input.status === "failed") instance.stoppedAt = now.toISOString();
      return instance;
    },

    async getActivationLease(leaseId) {
      return state.activationLeases.find((candidate) => candidate.id === leaseId) ?? null;
    },

    async renewActivationLease(leaseId, expiresAt, now = new Date()) {
      const lease = state.activationLeases.find((candidate) => candidate.id === leaseId);
      if (!lease || lease.releasedAt !== null || lease.expiresAt <= now.toISOString()) return null;
      lease.expiresAt = expiresAt.toISOString();
      return lease;
    },

    async releaseActivationLease(leaseId, now = new Date()) {
      const lease = state.activationLeases.find((candidate) => candidate.id === leaseId);
      if (!lease) return null;
      lease.releasedAt ??= now.toISOString();
      return lease;
    },

    async hasActiveActivationLeases(deploymentId, now = new Date()) {
      const nowIso = now.toISOString();
      return state.activationLeases.some(
        (candidate) => candidate.deploymentId === deploymentId && candidate.releasedAt === null && candidate.expiresAt > nowIso,
      );
    },

    async claimIdleRuntimeInstances(input) {
      if (!Number.isInteger(input.limit) || input.limit < 1) throw new Error("Runtime idle claim limit must be positive.");
      if (!Number.isFinite(input.idleTtlMs) || input.idleTtlMs < 0) throw new Error("Runtime idle TTL must be non-negative.");
      const schedulePrewarmMs = input.schedulePrewarmMs ?? 0;
      if (!Number.isFinite(schedulePrewarmMs) || schedulePrewarmMs < 0) {
        throw new Error("Schedule prewarm window must be non-negative.");
      }
      const cutoff = input.now.getTime() - input.idleTtlMs;
      const scheduleHorizon = input.now.getTime() + schedulePrewarmMs;
      const protectedScheduleRunStatuses = new Set(["queued", "activating", "dispatching", "running"]);
      const claimed: RuntimeInstance[] = [];
      const candidates = state.runtimeInstances
        .filter((instance) => instance.status === "draining" || instance.status === "ready")
        .sort((a, b) => a.deploymentId.localeCompare(b.deploymentId) || a.generation - b.generation);
      for (const instance of candidates) {
        if (claimed.length >= input.limit) break;
        if (instance.status === "draining") {
          claimed.push(instance);
          continue;
        }
        if (await this.hasActiveActivationLeases(instance.deploymentId, input.now)) continue;
        if (state.scheduleRuns.some(
          (run) => run.deploymentId === instance.deploymentId && protectedScheduleRunStatuses.has(run.status),
        )) continue;
        const targetProjectIds = new Set(
          state.projectSchedulerTargets
            .filter((target) => target.deploymentId === instance.deploymentId)
            .map((target) => target.projectId),
        );
        if (schedulePrewarmMs > 0 && state.projectSchedules.some(
          (schedule) =>
            targetProjectIds.has(schedule.projectId) &&
            schedule.enabled &&
            schedule.nextRunAt !== null &&
            Date.parse(schedule.nextRunAt) <= scheduleHorizon,
        )) continue;
        const activityTimes = [instance.readyAt, instance.startedAt]
          .concat(
            state.activationLeases
              .filter((lease) => lease.runtimeInstanceId === instance.id)
              .map((lease) => lease.releasedAt ?? lease.expiresAt),
          )
          .filter((value): value is string => value !== null)
          .map((value) => Date.parse(value));
        if (Math.max(...activityTimes) > cutoff) continue;
        instance.status = "draining";
        claimed.push(instance);
      }
      return claimed;
    },

  };
}
