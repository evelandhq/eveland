import { describe, expect, test } from "vitest";
import { createTestStore } from "@eveland/db/vitest";
import { createApp } from "./app.js";

describe("Built-in OTLP ingest", () => {
  test("accepts authenticated OTLP/HTTP JSON and hides the route otherwise", async () => {
    const store = createTestStore();
    const app = createApp(store, {
      otlpServiceToken: "collector-service-token",
    });
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              attribute("service.name", "eveland-api"),
              attribute("eveland.telemetry.domain", "platform"),
            ],
          },
          scopeSpans: [
            {
              scope: { name: "test" },
              spans: [
                {
                  traceId: "trace_1",
                  spanId: "span_1",
                  name: "GET /projects",
                  startTimeUnixNano: "1784808000000000000",
                  endTimeUnixNano: "1784808000125000000",
                },
              ],
            },
          ],
        },
      ],
    };

    const hidden = await app.request("/internal/otel/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(hidden.status).toBe(404);

    const accepted = await app.request("/internal/otel/v1/traces", {
      method: "POST",
      headers: {
        authorization: "Bearer collector-service-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({});
    await expect(store.listOtlpBatches({ signal: "traces" })).resolves.toHaveLength(1);
    await expect(store.listOtlpSpans({ limit: 10 })).resolves.toEqual([
      expect.objectContaining({
        traceId: "trace_1",
        spanId: "span_1",
        name: "GET /projects",
      }),
    ]);
  });

  test("rejects a signal with the wrong OTLP request shape", async () => {
    const app = createApp(createTestStore(), {
      otlpServiceToken: "collector-service-token",
    });
    const response = await app.request("/internal/otel/v1/logs", {
      method: "POST",
      headers: {
        authorization: "Bearer collector-service-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ resourceSpans: [] }),
    });

    expect(response.status).toBe(400);
  });

  test("projects Agent Session and usage read models from standard OTLP logs", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "OTLP Agent",
      importKind: "zip",
    });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/otlp-agent",
      summary: { eveVersion: "0.27.0" },
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/otlp-agent:test",
      containerName: "eveland-otlp-agent",
      internalPort: 3000,
      hostPort: 41000,
      runtimeKind: "docker",
    });
    const payload = agentLogBatch(deployment.id);
    const app = createApp(store, {
      otlpServiceToken: "collector-service-token",
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app.request("/internal/otel/v1/logs", {
        method: "POST",
        headers: {
          authorization: "Bearer collector-service-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(200);
    }

    const [session] = await store.listSessions(project.id);
    expect(session).toMatchObject({
      eveSessionId: "eve_session_1",
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        reportedSteps: 1,
      },
    });
    expect(await store.listSessionEvents(session!.id)).toHaveLength(2);
    await expect(store.listOtlpLogRecords({ limit: 10 })).resolves.toHaveLength(
      2,
    );
  });

  test("projects retry-safe Instance Health read models from standard OTLP metrics", async () => {
    const store = createTestStore();
    const app = createApp(store, {
      otlpServiceToken: "collector-service-token",
    });
    const payload = workerMetricBatch();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app.request("/internal/otel/v1/metrics", {
        method: "POST",
        headers: {
          authorization: "Bearer collector-service-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(200);
    }

    await expect(store.listWorkerHeartbeats()).resolves.toEqual([
      expect.objectContaining({
        workerId: "worker_1",
        intervalMs: 5000,
        lastError: null,
      }),
    ]);
    await expect(store.listHostMetrics({ limit: 10 })).resolves.toEqual([
      expect.objectContaining({
        workerId: "worker_1",
        cpuPercent: 30,
        memoryTotalBytes: 1000,
        diskTotalBytes: 1000,
      }),
    ]);
    await expect(
      store.listOtlpMetricPoints({ limit: 20 }),
    ).resolves.toHaveLength(11);
  });
});

function agentLogBatch(deploymentId: string) {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            attribute("service.name", "eveland-agent"),
            attribute("eveland.telemetry.domain", "agent"),
            attribute("eveland.deployment.id", deploymentId),
          ],
        },
        scopeLogs: [
          {
            logRecords: [
              logRecord("event_started", {
                type: "session.started",
                data: {
                  sequence: 1,
                  runtime: {
                    agentId: "root",
                    agentName: "Researcher",
                    modelId: "openai/gpt-5",
                    eveVersion: "0.27.0",
                  },
                },
              }),
              logRecord("event_step", {
                type: "step.completed",
                data: {
                  sequence: 2,
                  turnId: "turn_1",
                  stepIndex: 0,
                  finishReason: "stop",
                  usage: {
                    inputTokens: 120,
                    outputTokens: 30,
                  },
                },
              }),
            ],
          },
        ],
      },
    ],
  };
}

function logRecord(eventId: string, event: unknown) {
  return {
    timeUnixNano: "1784808000000000000",
    attributes: [
      attribute("eveland.event.id", eventId),
      attribute("eveland.event.fingerprint", `${eventId}_fingerprint`),
      attribute("eveland.eve.session.id", "eve_session_1"),
      attribute("eveland.eve.agent.name", "Researcher"),
      attribute("eveland.eve.agent.node.id", "root"),
      attribute("eveland.eve.channel.kind", "http"),
    ],
    body: anyValue(event),
  };
}

function attribute(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

function anyValue(value: unknown): Record<string, unknown> {
  if (value === null) return {};
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value };
  }
  if (typeof value === "boolean") return { boolValue: value };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(anyValue) } };
  }
  return {
    kvlistValue: {
      values: Object.entries(value as Record<string, unknown>).map(
        ([key, child]) => ({ key, value: anyValue(child) }),
      ),
    },
  };
}

function workerMetricBatch() {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            attribute("service.name", "eveland-worker"),
            attribute("eveland.telemetry.domain", "capacity"),
            attribute("service.instance.id", "worker_1"),
          ],
        },
        scopeMetrics: [
          {
            metrics: [
              gauge("eveland.worker.heartbeat", [
                metricPoint(1, {
                  "eveland.worker.poll_interval_ms": 5000,
                  "eveland.worker.tick.status": "ok",
                }),
              ]),
              histogram("eveland.worker.tick.duration", 3, 75),
              gauge("system.cpu.utilization", [
                metricPoint(0.2, {
                  "cpu.logical_number": 0,
                  "cpu.mode": "user",
                }),
                metricPoint(0.1, {
                  "cpu.logical_number": 0,
                  "cpu.mode": "system",
                }),
                metricPoint(0.7, {
                  "cpu.logical_number": 0,
                  "cpu.mode": "idle",
                }),
              ]),
              gauge("system.memory.usage", [
                metricPoint(600, { "system.memory.state": "used" }),
                metricPoint(400, { "system.memory.state": "free" }),
              ]),
              gauge("system.filesystem.usage", [
                metricPoint(700, { "system.filesystem.state": "used" }),
                metricPoint(300, { "system.filesystem.state": "free" }),
              ]),
              gauge("system.filesystem.limit", [metricPoint(1000)]),
              gauge("eveland.host.load.1m", [metricPoint(1.5)]),
            ],
          },
        ],
      },
    ],
  };
}

function gauge(
  name: string,
  dataPoints: Array<Record<string, unknown>>,
) {
  return { name, gauge: { dataPoints } };
}

function histogram(name: string, count: number, sum: number) {
  return {
    name,
    histogram: {
      dataPoints: [
        {
          count: String(count),
          sum,
          startTimeUnixNano: "1784807940000000000",
          timeUnixNano: "1784808000000000000",
          attributes: [],
        },
      ],
    },
  };
}

function metricPoint(
  value: number,
  attributes: Record<string, string | number> = {},
) {
  return {
    asDouble: value,
    startTimeUnixNano: "1784807940000000000",
    timeUnixNano: "1784808000000000000",
    attributes: Object.entries(attributes).map(([key, child]) => ({
      key,
      value:
        typeof child === "number"
          ? { intValue: String(child) }
          : { stringValue: child },
    })),
  };
}
