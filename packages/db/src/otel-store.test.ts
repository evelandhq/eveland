import { describe, expect, test } from "vitest";
import { createTestStore } from "./vitest-store.js";

describe("Built-in OTLP store", () => {
  test("persists standard signal batches and deduplicates Collector retries", async () => {
    const store = createTestStore();
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              {
                key: "service.name",
                value: { stringValue: "eveland-worker" },
              },
            ],
          },
          scopeSpans: [],
        },
      ],
    };

    const first = await store.ingestOtlpBatch({
      signal: "traces",
      payload,
    });
    const replay = await store.ingestOtlpBatch({
      signal: "traces",
      payload,
    });

    expect(first).toMatchObject({ accepted: true, duplicate: false });
    expect(replay).toMatchObject({
      id: first.id,
      accepted: true,
      duplicate: true,
    });
    await expect(store.listOtlpBatches({ signal: "traces" })).resolves.toEqual([
      expect.objectContaining({
        id: first.id,
        signal: "traces",
        payload,
      }),
    ]);
  });

  test("prunes raw signal batches independently", async () => {
    const store = createTestStore();
    await store.ingestOtlpBatch({
      signal: "traces",
      payload: { resourceSpans: [] },
    });
    await store.ingestOtlpBatch({
      signal: "logs",
      payload: { resourceLogs: [] },
    });
    await store.ingestOtlpBatch({
      signal: "metrics",
      payload: { resourceMetrics: [] },
    });

    await expect(
      store.pruneOtlpBatches({
        tracesBefore: new Date(Date.now() + 60_000),
        logsBefore: new Date(0),
        metricsBefore: new Date(0),
      }),
    ).resolves.toEqual({ traces: 1, logs: 0, metrics: 0 });
    await expect(store.listOtlpBatches()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ signal: "metrics" }),
        expect.objectContaining({ signal: "logs" }),
      ]),
    );
  });

  test("prunes completed Session and usage read models but keeps active Sessions", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Retention",
      importKind: "zip",
    });
    const completed = await store.createSession({
      projectId: project.id,
      trigger: "direct_http",
    });
    await store.appendSessionEvent(completed.id, "step.completed", {});
    await store.recordModelUsage(completed.id, {
      turnId: "turn_1",
      stepIndex: 0,
      finishReason: "stop",
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
      usageReported: true,
    });
    await store.completeSession(completed.id, {
      status: "completed",
    });
    const active = await store.createSession({
      projectId: project.id,
      trigger: "direct_http",
    });

    await expect(
      store.pruneDerivedAgentTelemetry(new Date(Date.now() + 60_000)),
    ).resolves.toEqual({
      sessions: 1,
      events: 1,
      usageEvents: 1,
      nodes: 0,
    });
    await expect(store.getSession(completed.id)).resolves.toBeNull();
    await expect(store.getSession(active.id)).resolves.toMatchObject({
      id: active.id,
      status: "running",
    });
  });
});
