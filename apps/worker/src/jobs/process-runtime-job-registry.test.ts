import { describe, expect, test } from "vitest";

describe("runtime job handler registry", () => {
  test("owns one handler for every runtime job type", async () => {
    const runtimeJobs = await import("./process-runtime-job.js");

    expect(runtimeJobs).toHaveProperty("runtimeJobHandlers");
    expect(Object.keys(runtimeJobs.runtimeJobHandlers ?? {}).sort()).toEqual([
      "archive_deployment",
      "delete_project",
      "ensure_deployment_running",
      "restart_deployment",
      "trigger_schedule",
    ]);
  });
});
