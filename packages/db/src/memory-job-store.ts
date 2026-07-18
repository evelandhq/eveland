import type { MemoryState } from "./memory-state.js";
import { createMemoryJob, type MemoryDomain } from "./memory-store-support.js";
import type { JobStore } from "./store-domains.js";

export function createMemoryJobStore(
  state: MemoryState,
): MemoryDomain<JobStore> {
  return {
    async enqueueJob(projectId, type, payload = {}) {
      const job = createMemoryJob(projectId, type, payload);
      state.jobs.push(job);
      return job;
    },

    async listProjectJobs(projectId, options = {}) {
      const limit = options.limit ?? 20;
      return state.jobs
        .filter(
          (job) =>
            job.projectId === projectId &&
            (!options.type || job.type === options.type),
        )
        .slice(-limit)
        .reverse();
    },

    async enqueueDeploymentActivation(
      projectId,
      deploymentId,
      runtimeInstanceId,
      now = new Date(),
      staleAfterMs = 300_000,
    ) {
      const existing = state.jobs.find(
        (candidate) =>
          candidate.projectId === projectId &&
          candidate.type === "ensure_deployment_running" &&
          candidate.payload.runtimeInstanceId === runtimeInstanceId &&
          (candidate.status === "queued" || candidate.status === "running"),
      );
      if (existing) {
        if (
          existing.status === "running" &&
          Date.parse(existing.updatedAt) <= now.getTime() - staleAfterMs
        ) {
          existing.status = "queued";
          existing.updatedAt = now.toISOString();
        }
        return existing;
      }
      const job = createMemoryJob(projectId, "ensure_deployment_running", {
        deploymentId,
        runtimeInstanceId,
      });
      job.createdAt = now.toISOString();
      job.updatedAt = now.toISOString();
      state.jobs.push(job);
      return job;
    },

    async claimNextJob(_workerId, now = new Date()) {
      const job = state.jobs.find((candidate) => {
        if (candidate.status !== "queued") return false;
        const project = state.projects.find(
          (entry) => entry.id === candidate.projectId,
        );
        if (project?.deletionStatus !== "deleting") return true;
        if (candidate.type !== "delete_project") return false;
        return !state.jobs.some(
          (other) =>
            other.projectId === candidate.projectId &&
            other.id !== candidate.id &&
            other.status === "running",
        );
      });
      if (!job) {
        return null;
      }

      job.status = "running";
      job.attempts += 1;
      job.updatedAt = now.toISOString();
      return job;
    },

    async recoverStaleJobs(
      now = new Date(),
      staleAfterMs = 300_000,
      limit = 25,
    ) {
      const cutoff = now.getTime() - staleAfterMs;
      const stale = state.jobs
        .filter(
          (job) =>
            job.status === "running" && Date.parse(job.updatedAt) <= cutoff,
        )
        .slice(0, limit);
      for (const job of stale) {
        job.status = "queued";
        job.updatedAt = now.toISOString();
      }
      return stale.length;
    },

    async heartbeatJob(jobId, attempt, now = new Date()) {
      const job = state.jobs.find(
        (candidate) =>
          candidate.id === jobId &&
          candidate.status === "running" &&
          candidate.attempts === attempt,
      );
      if (!job) return false;
      job.updatedAt = now.toISOString();
      return true;
    },

    async replaceJobPayload(jobId, payload, attempt) {
      const job = state.jobs.find(
        (candidate) =>
          candidate.id === jobId &&
          candidate.status === "running" &&
          candidate.attempts === attempt,
      );
      if (!job) return false;
      job.payload = payload;
      job.updatedAt = new Date().toISOString();
      return true;
    },

    async completeJob(jobId, attempt) {
      const job = state.jobs.find(
        (candidate) =>
          candidate.id === jobId &&
          (attempt === undefined ||
            (candidate.status === "running" && candidate.attempts === attempt)),
      );
      if (!job) return false;
      job.status = "completed";
      job.updatedAt = new Date().toISOString();
      return true;
    },

    async failJob(jobId, error, attempt) {
      const job = state.jobs.find(
        (candidate) =>
          candidate.id === jobId &&
          (attempt === undefined ||
            (candidate.status === "running" && candidate.attempts === attempt)),
      );
      if (!job) return false;
      job.status = "failed";
      job.lastError = error;
      job.updatedAt = new Date().toISOString();
      return true;
    },
  };
}
