import { describe, expect, test } from "vitest";
import { createTestStore } from "./vitest-store.js";

describe("Built-in OTLP store", () => {
  test("indexes spans idempotently and supports activity filters", async () => {
    const store = createTestStore();
    const span = spanProjection();

    await expect(store.ingestOtlpSpans([span])).resolves.toEqual({
      inserted: 1,
    });
    await expect(store.ingestOtlpSpans([span])).resolves.toEqual({
      inserted: 0,
    });
    await expect(
      store.listOtlpSpans({
        domain: "platform",
        serviceName: "eveland-api",
        projectId: "proj_1",
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: expect.any(String),
        receivedAt: expect.any(String),
        traceId: "trace_1",
        spanId: "span_1",
        name: "GET /projects",
        resource: expect.objectContaining({
          domain: "platform",
          serviceName: "eveland-api",
        }),
      }),
    ]);
    await expect(
      store.listOtlpSpans({ domain: "agent", limit: 10 }),
    ).resolves.toEqual([]);
  });

  test("indexes LogRecords idempotently and supports activity filters", async () => {
    const store = createTestStore();
    const logRecord = logProjection();

    await expect(
      store.ingestOtlpLogRecords([logRecord]),
    ).resolves.toEqual({ inserted: 1 });
    await expect(
      store.ingestOtlpLogRecords([logRecord]),
    ).resolves.toEqual({ inserted: 0 });
    await expect(
      store.listOtlpLogRecords({
        domain: "runtime",
        serviceName: "eveland-worker",
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: expect.any(String),
        receivedAt: expect.any(String),
        eventName: "eveland.runtime.log",
        body: "Deployment ready.",
        resource: expect.objectContaining({
          deploymentId: "dep_1",
        }),
      }),
    ]);
  });

  test("indexes Metric Points idempotently and supports activity filters", async () => {
    const store = createTestStore();
    const metric = metricProjection();

    await expect(
      store.ingestOtlpMetricPoints([metric]),
    ).resolves.toEqual({ inserted: 1 });
    await expect(
      store.ingestOtlpMetricPoints([metric]),
    ).resolves.toEqual({ inserted: 0 });
    await expect(
      store.ingestOtlpMetricPoints([
        {
          ...metric,
          value: { asDouble: 601 },
          payload: { asDouble: 601 },
        },
      ]),
    ).resolves.toEqual({ inserted: 0 });
    await expect(
      store.listOtlpMetricPoints({
        domain: "capacity",
        serviceName: "eveland-worker",
        projectId: "proj_1",
        name: "system.memory.usage",
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: expect.any(String),
        receivedAt: expect.any(String),
        name: "system.memory.usage",
        dataType: "gauge",
        value: { asDouble: 600 },
        resource: expect.objectContaining({
          serviceName: "eveland-worker",
          domain: "capacity",
        }),
      }),
    ]);
    await expect(
      store.listOtlpMetricPoints({
        name: "system.cpu.utilization",
        limit: 10,
      }),
    ).resolves.toEqual([]);
  });

  test("filters Agent spans and logs by Eve Session and trace correlation", async () => {
    const store = createTestStore();
    const firstSpan = {
      ...spanProjection(),
      attributes: { "eveland.eve.session.id": "eve_session_1" },
    };
    const secondSpan = {
      ...spanProjection(),
      traceId: "trace_2",
      spanId: "span_2",
      attributes: { "eveland.eve.session.id": "eve_session_2" },
      payload: { traceId: "trace_2", spanId: "span_2" },
    };
    const firstLog = {
      ...logProjection(),
      attributes: { "eveland.eve.session.id": "eve_session_1" },
    };
    const secondLog = {
      ...logProjection(),
      traceId: "trace_2",
      spanId: "span_2",
      timestamp: "2026-07-23T12:00:01.000Z",
      attributes: { "eveland.eve.session.id": "eve_session_2" },
      payload: { eventName: "eveland.runtime.log.2" },
    };
    await store.ingestOtlpSpans([firstSpan, secondSpan]);
    await store.ingestOtlpLogRecords([firstLog, secondLog]);

    await expect(
      store.listOtlpSpans({
        eveSessionIds: ["eve_session_1"],
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ traceId: "trace_1" }),
    ]);
    await expect(
      store.listOtlpLogRecords({
        traceIds: ["trace_1"],
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ traceId: "trace_1" }),
    ]);
  });

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
      store.pruneOtlpTelemetry({
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

  test("prunes indexed spans and LogRecords with their signal windows", async () => {
    const store = createTestStore();
    await store.ingestOtlpSpans([spanProjection()]);
    await store.ingestOtlpLogRecords([logProjection()]);
    await store.ingestOtlpMetricPoints([metricProjection()]);

    await expect(
      store.pruneOtlpTelemetry({
        tracesBefore: new Date("2026-07-24T00:00:00.000Z"),
        logsBefore: new Date("2026-07-24T00:00:00.000Z"),
        metricsBefore: new Date("2026-07-24T00:00:00.000Z"),
      }),
    ).resolves.toEqual({ traces: 1, logs: 1, metrics: 1 });
    await expect(
      store.listOtlpSpans({ limit: 10 }),
    ).resolves.toEqual([]);
    await expect(
      store.listOtlpLogRecords({ limit: 10 }),
    ).resolves.toEqual([]);
    await expect(
      store.listOtlpMetricPoints({ limit: 10 }),
    ).resolves.toEqual([]);
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

function spanProjection() {
  return {
    traceId: "trace_1",
    spanId: "span_1",
    parentSpanId: null,
    name: "GET /projects",
    kind: 2,
    startedAt: "2026-07-23T12:00:00.000Z",
    endedAt: "2026-07-23T12:00:00.125Z",
    durationMs: 125,
    statusCode: 1,
    statusMessage: null,
    scopeName: "@opentelemetry/instrumentation-http",
    attributes: { "http.request.method": "GET" },
    resource: {
      serviceName: "eveland-api",
      domain: "platform" as const,
      projectId: "proj_1",
      deploymentId: null,
      attributes: {
        "service.name": "eveland-api",
        "eveland.telemetry.domain": "platform",
      },
    },
    payload: { traceId: "trace_1", spanId: "span_1" },
  };
}

function logProjection() {
  return {
    traceId: "trace_1",
    spanId: "span_1",
    timestamp: "2026-07-23T12:00:00.000Z",
    observedTimestamp: "2026-07-23T12:00:00.100Z",
    severityNumber: 9,
    severityText: "INFO",
    eventName: "eveland.runtime.log",
    scopeName: "@eveland/platform-observability",
    body: "Deployment ready.",
    attributes: { "eveland.log.type": "runtime" },
    resource: {
      serviceName: "eveland-worker",
      domain: "runtime" as const,
      projectId: null,
      deploymentId: "dep_1",
      attributes: {
        "service.name": "eveland-worker",
        "eveland.telemetry.domain": "runtime",
      },
    },
    payload: { eventName: "eveland.runtime.log" },
  };
}

function metricProjection() {
  return {
    name: "system.memory.usage",
    description: "Memory usage by state.",
    unit: "By",
    dataType: "gauge" as const,
    aggregationTemporality: null,
    monotonic: null,
    startTimestamp: "2026-07-23T11:59:00.000Z",
    timestamp: "2026-07-23T12:00:00.000Z",
    scopeName: "@eveland/platform-observability",
    attributes: { "system.memory.state": "used" },
    value: { asDouble: 600 },
    resource: {
      serviceName: "eveland-worker",
      domain: "capacity" as const,
      projectId: "proj_1",
      deploymentId: null,
      attributes: {
        "service.name": "eveland-worker",
        "eveland.telemetry.domain": "capacity",
      },
    },
    payload: { asDouble: 600 },
  };
}
