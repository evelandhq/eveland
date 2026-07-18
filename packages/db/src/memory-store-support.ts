import type { Job, JobType } from "@eveland/core/contracts";
import { createId } from "@eveland/core/ids";
import type { Store } from "./store-domains.js";

export type MemoryDomain<T> = T & ThisType<Store>;

export function createMemoryJob(projectId: string, type: JobType, payload: Record<string, unknown>): Job {
  const now = new Date().toISOString();
  return {
    id: createId("job"),
    projectId,
    type,
    status: "queued",
    payload,
    attempts: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}
