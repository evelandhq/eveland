import { describe, expect, test } from "vitest";

import { jobRowToJob } from "./mappers.js";

const baseRow = {
  id: "job_1",
  projectId: "proj_1",
  status: "queued",
  attempts: 0,
  lastError: null,
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
};

describe("jobRowToJob", () => {
  test("rejects a persisted payload that does not match the job type", () => {
    expect(() =>
      jobRowToJob({
        ...baseRow,
        type: "trigger_schedule",
        payload: {},
      }),
    ).toThrow(/invalid job payload/i);
  });

  test("rejects unknown persisted job types and statuses", () => {
    expect(() =>
      jobRowToJob({
        ...baseRow,
        type: "future_job",
        payload: {},
      }),
    ).toThrow(/invalid job type/i);
    expect(() =>
      jobRowToJob({
        ...baseRow,
        type: "build_deploy",
        status: "future_status",
        payload: {},
      }),
    ).toThrow(/invalid job status/i);
  });
});
