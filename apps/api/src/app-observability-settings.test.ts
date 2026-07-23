import { describe, expect, test } from "vitest";
import { DEFAULT_TEAM_ID } from "@eveland/db";
import { createTestStore } from "@eveland/db/vitest";
import {
  decryptSecretValue,
  type EncryptedSecret,
} from "@eveland/core/server/secrets";
import { createApp } from "./app.js";

const appSecretKey = "0123456789abcdef0123456789abcdef";

describe("observability settings", () => {
  test("updates revisioned Agent capture policy without exposing destination secrets", async () => {
    const store = createTestStore();
    const app = createApp(store);

    const initial = await app.request("/system/observability");
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      revision: 1,
      builtIn: {
        configurable: false,
        signals: ["traces", "logs", "metrics"],
        health: {
          status: "waiting",
          lastReceivedAt: null,
        },
      },
      agentCapture: {
        enabled: true,
        sampling: { ratio: 1 },
        recordInputs: false,
        recordOutputs: false,
        includeReasoning: false,
      },
      externalDestinations: [],
    });

    const updated = await app.request("/system/observability", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 1,
        agentCapture: {
          enabled: false,
          sampling: { ratio: 0.25 },
          recordInputs: true,
          recordOutputs: false,
          includeReasoning: false,
        },
      }),
    });
    expect(updated.status).toBe(200);
    const updatedBody = await updated.json();
    expect(updatedBody).toMatchObject({
      revision: 2,
      agentCapture: {
        enabled: false,
        sampling: { ratio: 0.25 },
        recordInputs: true,
      },
    });

    const stale = await app.request("/system/observability", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 1,
        agentCapture: {
          enabled: true,
          sampling: { ratio: 1 },
          recordInputs: false,
          recordOutputs: false,
          includeReasoning: false,
        },
      }),
    });
    expect(stale.status).toBe(409);
    expect(JSON.stringify(updatedBody)).not.toContain("encryptedConfig");
  });

  test("shows Built-in ingestion health without making it configurable", async () => {
    const store = createTestStore();
    await store.ingestOtlpBatch({
      signal: "traces",
      payload: { resourceSpans: [] },
    });
    const app = createApp(store);

    const response = await app.request("/system/observability");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      builtIn: {
        configurable: false,
        health: {
          status: "healthy",
          lastReceivedAt: expect.any(String),
        },
      },
    });
  });

  test("lists recent Built-in spans, logs, and metrics for the monitoring UI", async () => {
    const store = createTestStore();
    await store.ingestOtlpSpans([
      {
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
        scopeName: "test",
        attributes: {},
        resource: {
          serviceName: "eveland-api",
          domain: "platform",
          projectId: null,
          deploymentId: null,
          attributes: {},
        },
        payload: {},
      },
    ]);
    await store.ingestOtlpLogRecords([
      {
        traceId: "trace_1",
        spanId: "span_1",
        timestamp: "2026-07-23T12:00:00.000Z",
        observedTimestamp: null,
        severityNumber: 9,
        severityText: "INFO",
        eventName: "eveland.runtime.log",
        scopeName: "test",
        body: "Deployment ready.",
        attributes: {},
        resource: {
          serviceName: "eveland-worker",
          domain: "runtime",
          projectId: null,
          deploymentId: "dep_1",
          attributes: {},
        },
        payload: {},
      },
    ]);
    await store.ingestOtlpMetricPoints([
      {
        name: "system.memory.usage",
        description: "Memory usage by state.",
        unit: "By",
        dataType: "gauge",
        aggregationTemporality: null,
        monotonic: null,
        startTimestamp: null,
        timestamp: "2026-07-23T12:00:00.000Z",
        scopeName: "test",
        attributes: { "system.memory.state": "used" },
        value: { asDouble: 600 },
        resource: {
          serviceName: "eveland-worker",
          domain: "capacity",
          projectId: null,
          deploymentId: null,
          attributes: {},
        },
        payload: {},
      },
    ]);
    const app = createApp(store);

    const response = await app.request(
      "/system/observability/activity?limit=10",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      spans: [
        expect.objectContaining({
          traceId: "trace_1",
          name: "GET /projects",
        }),
      ],
      logs: [
        expect.objectContaining({
          eventName: "eveland.runtime.log",
          body: "Deployment ready.",
        }),
      ],
      metrics: [
        expect.objectContaining({
          name: "system.memory.usage",
          value: { asDouble: 600 },
        }),
      ],
      delivery: {
        generatedAt: expect.any(String),
        destinations: [
          expect.objectContaining({
            id: "builtin",
            label: "Built-in",
            exporterId: "otlp_http/builtin",
            status: "waiting",
          }),
        ],
      },
    });
  });

  test("reports Collector delivery and queue diagnostics for configured exporters", async () => {
    const store = createTestStore();
    const app = createApp(store, { appSecretKey });
    const created = await app.request(
      "/system/observability/destinations",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: 1,
          config: {
            kind: "elastic",
            endpoint: "https://elastic.example.com:4318",
            authorization: {
              type: "api_key",
              value: "elastic-secret",
            },
          },
        }),
      },
    );
    expect(created.status).toBe(201);
    const policy = await store.getObservabilityPolicy(DEFAULT_TEAM_ID);
    const destinationId = policy.externalDestinations[0]!.id;
    await store.ingestOtlpMetricPoints([
      collectorMetric(
        "otelcol_exporter_queue_size",
        0,
        "otlp_http/builtin",
      ),
      collectorMetric(
        "otelcol_exporter_queue_capacity",
        10_000,
        "otlp_http/builtin",
      ),
      collectorMetric(
        "otelcol_exporter_queue_size",
        9_000,
        `otlp_http/${destinationId}`,
      ),
      collectorMetric(
        "otelcol_exporter_queue_capacity",
        10_000,
        `otlp_http/${destinationId}`,
      ),
    ]);

    const response = await app.request(
      "/system/observability/activity?limit=10",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      delivery: {
        destinations: [
          { id: "builtin", status: "healthy" },
          {
            id: destinationId,
            label: "Elastic",
            status: "degraded",
            queue: {
              size: 9_000,
              capacity: 10_000,
              utilization: 0.9,
            },
          },
        ],
      },
    });
  });

  test("encrypts and revision-controls external destinations", async () => {
    const store = createTestStore();
    const app = createApp(store, { appSecretKey });

    const created = await app.request(
      "/system/observability/destinations",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: 1,
          config: {
            kind: "elastic",
            endpoint: "https://elastic.example.com:8200",
            authorization: {
              type: "api_key",
              value: "elastic-secret-api-key",
            },
          },
        }),
      },
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody).toMatchObject({
      revision: 2,
      externalDestinations: [
        {
          kind: "elastic",
          enabled: true,
          configured: true,
          supportedSignals: ["traces", "logs", "metrics"],
          filterProfile: "all_eveland",
          securityRevision: 1,
          health: {
            status: "pending",
            checkedAt: null,
          },
        },
      ],
    });
    expect(JSON.stringify(createdBody)).not.toContain(
      "elastic-secret-api-key",
    );

    const stored = await store.getObservabilityPolicy(DEFAULT_TEAM_ID);
    const encrypted = JSON.parse(
      stored.externalDestinations[0]!.encryptedConfig,
    ) as EncryptedSecret;
    expect(
      JSON.parse(decryptSecretValue(encrypted, appSecretKey)),
    ).toMatchObject({
      kind: "elastic",
      endpoint: "https://elastic.example.com:8200",
      authorization: { value: "elastic-secret-api-key" },
    });

    const disabled = await app.request(
      `/system/observability/destinations/${stored.externalDestinations[0]!.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: 2,
          enabled: false,
        }),
      },
    );
    expect(disabled.status).toBe(200);
    await expect(disabled.json()).resolves.toMatchObject({
      revision: 3,
      externalDestinations: [
        {
          enabled: false,
          securityRevision: 1,
          health: { status: "paused" },
        },
      ],
    });

    const removed = await app.request(
      `/system/observability/destinations/${stored.externalDestinations[0]!.id}`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: 3 }),
      },
    );
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toMatchObject({
      revision: 4,
      externalDestinations: [],
    });
  });
});

function collectorMetric(
  name: string,
  value: number,
  exporterId: string,
) {
  const timestamp = new Date().toISOString();
  return {
    name,
    description: null,
    unit: "{batch}",
    dataType: "gauge" as const,
    aggregationTemporality: null,
    monotonic: null,
    startTimestamp: null,
    timestamp,
    scopeName: "go.opentelemetry.io/collector/exporter/exporterhelper",
    attributes: { "otelcol.component.id": exporterId },
    value: { asDouble: value },
    resource: {
      serviceName: "eveland-otel-collector",
      domain: "platform" as const,
      projectId: null,
      deploymentId: null,
      attributes: {},
    },
    payload: {},
  };
}
