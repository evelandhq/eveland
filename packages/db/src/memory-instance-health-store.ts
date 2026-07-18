import { createId } from "@eveland/core/ids";
import type { MemoryState } from "./memory-state.js";
import type { InstanceHealthStore } from "./store-domains.js";
import type { MemoryDomain } from "./memory-store-support.js";

export function createMemoryInstanceHealthStore(
  state: MemoryState,
): MemoryDomain<InstanceHealthStore> {
  return {
    async upsertWorkerHeartbeat(heartbeat) {
      const index = state.workerHeartbeats.findIndex((entry) => entry.workerId === heartbeat.workerId);
      if (index >= 0) state.workerHeartbeats[index] = { ...heartbeat };
      else state.workerHeartbeats.push({ ...heartbeat });
      return { ...heartbeat };
    },

    async listWorkerHeartbeats() {
      return [...state.workerHeartbeats]
        .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))
        .map((heartbeat) => ({ ...heartbeat }));
    },

    async recordHostMetric(sample) {
      const record = { ...sample, id: createId("metric") };
      state.hostMetricSamples.push(record);
      return { ...record };
    },

    async listHostMetrics(input) {
      if (!Number.isInteger(input.limit) || input.limit < 1) {
        throw new Error("Host metric list limit must be positive.");
      }
      const since = input.since?.getTime() ?? Number.NEGATIVE_INFINITY;
      return state.hostMetricSamples
        .filter((sample) =>
          (!input.workerId || sample.workerId === input.workerId)
          && Date.parse(sample.observedAt) >= since,
        )
        .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))
        .slice(0, input.limit)
        .reverse()
        .map((sample) => ({ ...sample }));
    },

    async pruneHostMetrics(before) {
      const keep = state.hostMetricSamples.filter((sample) => Date.parse(sample.observedAt) >= before.getTime());
      const deleted = state.hostMetricSamples.length - keep.length;
      state.hostMetricSamples.splice(0, state.hostMetricSamples.length, ...keep);
      return deleted;
    },

    async getInstanceWorkload() {
      const queued = state.jobs.filter((job) => job.status === "queued");
      const runtimeInstances = { starting: 0, ready: 0, draining: 0, stopped: 0, failed: 0 };
      for (const instance of state.runtimeInstances) runtimeInstances[instance.status] += 1;
      return {
        queuedJobs: queued.length,
        runningJobs: state.jobs.filter((job) => job.status === "running").length,
        oldestQueuedAt: queued.map((job) => job.createdAt).sort()[0] ?? null,
        runtimeInstances,
      };
    },
  };
}
