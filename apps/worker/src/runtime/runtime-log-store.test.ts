import { describe, expect, test, vi } from "vitest";
import type { Store } from "@eveland/db";
import { instrumentRuntimeLogStore } from "./runtime-log-store.js";

describe("runtime OTel log projection", () => {
  test("preserves product log writes and emits a runtime-domain LogRecord", async () => {
    const appendLog = vi.fn().mockResolvedValue({
      id: "log_1",
      projectId: "proj_1",
      deploymentId: "dep_1",
      type: "runtime",
      line: "Deployment ready.",
      createdAt: "2026-07-23T12:00:00.000Z",
    });
    const emitLog = vi.fn();
    const store = instrumentRuntimeLogStore({ appendLog } as unknown as Store, { emitLog });

    await expect(
      store.appendLog({
        projectId: "proj_1",
        deploymentId: "dep_1",
        type: "runtime",
        line: "Deployment ready.",
      }),
    ).resolves.toMatchObject({ id: "log_1" });
    expect(appendLog).toHaveBeenCalledOnce();
    expect(emitLog).toHaveBeenCalledWith({
      severity: "info",
      eventName: "eveland.runtime.log",
      body: "Deployment ready.",
      attributes: {
        "eveland.project.id": "proj_1",
        "eveland.deployment.id": "dep_1",
        "eveland.log.type": "runtime",
      },
    });
  });
});
