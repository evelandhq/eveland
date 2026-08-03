import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";

import { jobs } from "./schema.js";
import { createPgliteTestStore } from "./test-store.js";

describe("invalid persisted jobs", () => {
  test("quarantines an invalid job without leaking its payload and claims the next job", async () => {
    const database = await createPgliteTestStore();
    try {
      const project = await database.store.createProject({
        name: "Poison Job Agent",
        importKind: "zip",
        sourcePath: "/tmp/poison-job-agent",
      });
      const importJob = await database.store.claimNextJob("worker-a");
      await database.store.completeJob(importJob!.id, importJob!.attempts);

      await database.db.insert(jobs).values({
        id: "job_invalid_payload",
        projectId: project.id,
        type: "trigger_schedule",
        status: "queued",
        payload: {
          scheduleRunId: 42,
          secret: "must-not-appear-in-last-error",
        },
      });
      const validJob = await database.store.enqueueJob(project.id, "build_deploy");

      await expect(database.store.claimNextJob("worker-a")).resolves.toMatchObject({
        id: validJob.id,
        type: "build_deploy",
      });

      const [quarantined] = await database.db
        .select()
        .from(jobs)
        .where(eq(jobs.id, "job_invalid_payload"));
      expect(quarantined).toMatchObject({
        status: "failed",
        lockedAt: null,
        attempts: 1,
        lastError: expect.stringMatching(/invalid persisted job contract/i),
      });
      expect(quarantined?.lastError).not.toContain("must-not-appear-in-last-error");
    } finally {
      await database.close();
    }
  });
});
