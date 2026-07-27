import { createServer } from "node:http";
import { afterEach, describe, expect, test, vi } from "vitest";

import { dispatchScheduleToRuntime } from "./process-support.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("dispatchScheduleToRuntime", () => {
  test("identifies Scheduler Channel timeouts with run and deployment context", async () => {
    const server = createServer(() => {
      // Keep the request open until the worker-side timeout aborts it.
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP test server.");
    }
    vi.stubEnv("EVELAND_SCHEDULER_DISPATCH_TIMEOUT_MS", "20");

    try {
      await expect(
        dispatchScheduleToRuntime({
          scheduleRunId: "srun_timeout",
          scheduleKey: "daily-merchant-sync",
          deploymentId: "dep_timeout",
          hostPort: address.port,
          credential: "test-credential",
          runtimeSecret: "test-runtime-secret",
        }),
      ).rejects.toThrow(
        "Scheduler Channel timed out after 20ms for ScheduleRun srun_timeout on Deployment dep_timeout.",
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });
});
