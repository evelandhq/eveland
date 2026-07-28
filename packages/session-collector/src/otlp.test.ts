import { describe, expect, test } from "vitest";
import {
  createOtlpPartialSuccessResponse,
  countOtlpSignalItems,
  projectAgentEventItemsFromOtlpLogs,
  projectAgentEventsFromOtlpLogs,
  projectInstanceTelemetryFromOtlpMetrics,
  projectOtlpLogRecords,
  projectOtlpMetricPoints,
  projectOtlpSpans,
} from "./otlp.js";

describe("OTLP response accounting", () => {
  test("counts signal items and uses the standard partial-success fields", () => {
    expect(
      countOtlpSignalItems("traces", {
        resourceSpans: [
          {
            scopeSpans: [
              { spans: [{ name: "one" }, { name: "two" }] },
            ],
          },
        ],
      }),
    ).toBe(2);
    expect(
      countOtlpSignalItems("logs", {
        resourceLogs: [
          {
            scopeLogs: [
              { logRecords: [{ body: {} }, { body: {} }] },
            ],
          },
        ],
      }),
    ).toBe(2);
    expect(
      countOtlpSignalItems("metrics", {
        resourceMetrics: [
          {
            scopeMetrics: [
              {
                metrics: [
                  { gauge: { dataPoints: [{}, {}] } },
                  { histogram: { dataPoints: [{}] } },
                ],
              },
            ],
          },
        ],
      }),
    ).toBe(3);

    expect(createOtlpPartialSuccessResponse("traces", 2)).toEqual({
      partialSuccess: {
        rejectedSpans: "2",
        errorMessage: expect.stringContaining("required"),
      },
    });
    expect(createOtlpPartialSuccessResponse("logs", 2)).toEqual({
      partialSuccess: {
        rejectedLogRecords: "2",
        errorMessage: expect.stringContaining("required"),
      },
    });
    expect(createOtlpPartialSuccessResponse("metrics", 2)).toEqual({
      partialSuccess: {
        rejectedDataPoints: "2",
        errorMessage: expect.stringContaining("required"),
      },
    });
    expect(createOtlpPartialSuccessResponse("traces", 0)).toEqual({});
  });
});

describe("OTLP trace projection", () => {
  test("indexes standard OTLP spans with Eveland Resource provenance", () => {
    expect(
      projectOtlpSpans({
        resourceSpans: [
          {
            resource: {
              attributes: [
                attribute("service.name", "eveland-api"),
                attribute("eveland.telemetry.domain", "platform"),
                attribute("eveland.project.id", "proj_1"),
              ],
            },
            scopeSpans: [
              {
                scope: { name: "@opentelemetry/instrumentation-http" },
                spans: [
                  {
                    traceId: "trace_1",
                    spanId: "span_1",
                    parentSpanId: "parent_1",
                    name: "GET /projects",
                    kind: 2,
                    startTimeUnixNano: "1784808000000000000",
                    endTimeUnixNano: "1784808000125000000",
                    attributes: [
                      attribute("http.request.method", "GET"),
                    ],
                    status: { code: 1 },
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        traceId: "trace_1",
        spanId: "span_1",
        parentSpanId: "parent_1",
        name: "GET /projects",
        kind: 2,
        startedAt: "2026-07-23T12:00:00.000Z",
        endedAt: "2026-07-23T12:00:00.125Z",
        durationMs: 125,
        statusCode: 1,
        scopeName: "@opentelemetry/instrumentation-http",
        attributes: { "http.request.method": "GET" },
        resource: {
          serviceName: "eveland-api",
          domain: "platform",
          projectId: "proj_1",
          deploymentId: null,
          attributes: expect.objectContaining({
            "service.name": "eveland-api",
            "eveland.telemetry.domain": "platform",
          }),
        },
      }),
    ]);
  });

  test("ignores resources that are not marked as Eveland telemetry", () => {
    expect(
      projectOtlpSpans({
        resourceSpans: [
          {
            resource: {
              attributes: [
                attribute("service.name", "user-agent"),
              ],
            },
            scopeSpans: [],
          },
        ],
      }),
    ).toEqual([]);
  });
});

describe("OTLP log indexing projection", () => {
  test("indexes standard LogRecords independently from Agent read models", () => {
    expect(
      projectOtlpLogRecords({
        resourceLogs: [
          {
            resource: {
              attributes: [
                attribute("service.name", "eveland-worker"),
                attribute("eveland.telemetry.domain", "runtime"),
                attribute("eveland.deployment.id", "dep_1"),
              ],
            },
            scopeLogs: [
              {
                scope: { name: "@eveland/platform-observability" },
                logRecords: [
                  {
                    timeUnixNano: "1784808000000000000",
                    observedTimeUnixNano: "1784808000100000000",
                    traceId: "trace_1",
                    spanId: "span_1",
                    severityNumber: 9,
                    severityText: "INFO",
                    eventName: "eveland.runtime.log",
                    body: { stringValue: "Deployment ready." },
                    attributes: [
                      attribute("eveland.log.type", "runtime"),
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
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
        resource: expect.objectContaining({
          serviceName: "eveland-worker",
          domain: "runtime",
          deploymentId: "dep_1",
        }),
      }),
    ]);
  });
});

describe("OTLP Agent event projection", () => {
  const projection = {
    resolveDeploymentId: (credential: string | undefined) =>
      credential === "credential_dep_1" ? "dep_1" : undefined,
  };

  test("keeps one projection result per received LogRecord", () => {
    const payload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              attribute("eveland.telemetry.domain", "agent"),
              attribute("eveland.deployment.credential", "credential_dep_1"),
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1784808000000000000",
                  attributes: [],
                  body: { stringValue: "not an Eve event" },
                },
              ],
            },
          ],
        },
      ],
    };

    expect(projectAgentEventItemsFromOtlpLogs(payload, projection)).toEqual([
      null,
    ]);
    expect(projectAgentEventsFromOtlpLogs(payload, projection)).toEqual([]);
  });

  test("maps standard OTLP/HTTP JSON LogRecords to Session observations", () => {
    const observations = projectAgentEventsFromOtlpLogs({
      resourceLogs: [
        {
          resource: {
            attributes: [
              attribute("eveland.telemetry.domain", "agent"),
              attribute("eveland.deployment.credential", "credential_dep_1"),
              attribute("eveland.runtime.instance.id", "rti_1"),
            ],
          },
          scopeLogs: [
            {
              scope: { name: "@eveland/eve-runtime" },
              logRecords: [
                {
                  timeUnixNano: "1784808000000000000",
                  attributes: [
                    attribute("eveland.event.id", "event_1"),
                    attribute("eveland.event.fingerprint", "fingerprint_1"),
                    attribute("eveland.eve.session.id", "eve_session_1"),
                    attribute(
                      "eveland.eve.parent_session.id",
                      "eve_parent_1",
                    ),
                    attribute("eveland.eve.agent.name", "Researcher"),
                    attribute("eveland.eve.agent.node.id", "root"),
                    attribute("eveland.eve.channel.kind", "http"),
                  ],
                  body: anyValue({
                    type: "step.completed",
                    data: {
                      sequence: 7,
                      turnId: "turn_1",
                      stepIndex: 0,
                      usage: {
                        inputTokens: 120,
                        outputTokens: 30,
                      },
                    },
                  }),
                },
              ],
            },
          ],
        },
      ],
    }, projection);

    expect(observations).toEqual([
      {
        telemetryEventId: "event_1",
        eventFingerprint: "fingerprint_1",
        deploymentId: "dep_1",
        runtimeInstanceId: "rti_1",
        eveSessionId: "eve_session_1",
        parentEveSessionId: "eve_parent_1",
        sourceSequence: 7,
        agent: {
          id: null,
          name: "Researcher",
          nodeId: "root",
        },
        channelKind: "http",
        eventAt: "2026-07-23T12:00:00.000Z",
        event: {
          type: "step.completed",
          data: {
            sequence: 7,
            turnId: "turn_1",
            stepIndex: 0,
            usage: {
              inputTokens: 120,
              outputTokens: 30,
            },
          },
        },
      },
    ]);
  });

  test("ignores non-Agent resources and malformed LogRecords", () => {
    expect(
      projectAgentEventsFromOtlpLogs({
        resourceLogs: [
          {
            resource: {
              attributes: [
                attribute("eveland.telemetry.domain", "platform"),
              ],
            },
            scopeLogs: [
              {
                logRecords: [
                  {
                    body: { stringValue: "API ready" },
                    attributes: [],
                  },
                ],
              },
            ],
          },
        ],
      }, projection),
    ).toEqual([]);
  });

  test("ignores the Agent-supplied deployment id and trusts only the credential", () => {
    const forged = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              attribute("eveland.telemetry.domain", "agent"),
              attribute("eveland.deployment.id", "dep_victim"),
              attribute("eveland.deployment.credential", "credential_dep_1"),
            ],
          },
          scopeLogs: [
            {
              scope: { name: "@eveland/eve-runtime" },
              logRecords: [
                {
                  timeUnixNano: "1784808000000000000",
                  attributes: [
                    attribute("eveland.event.id", "event_1"),
                    attribute("eveland.event.fingerprint", "fingerprint_1"),
                    attribute("eveland.eve.session.id", "eve_session_1"),
                  ],
                  body: anyValue({ type: "session.started", data: {} }),
                },
              ],
            },
          ],
        },
      ],
    };

    expect(
      projectAgentEventsFromOtlpLogs(forged, projection).map(
        (observation) => observation.deploymentId,
      ),
    ).toEqual(["dep_1"]);
  });

  test("drops Agent resources whose credential does not verify", () => {
    const unsigned = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              attribute("eveland.telemetry.domain", "agent"),
              attribute("eveland.deployment.id", "dep_1"),
              attribute("eveland.deployment.credential", "forged"),
            ],
          },
          scopeLogs: [
            {
              scope: { name: "@eveland/eve-runtime" },
              logRecords: [
                {
                  timeUnixNano: "1784808000000000000",
                  attributes: [
                    attribute("eveland.event.id", "event_1"),
                    attribute("eveland.event.fingerprint", "fingerprint_1"),
                    attribute("eveland.eve.session.id", "eve_session_1"),
                  ],
                  body: anyValue({ type: "session.started", data: {} }),
                },
              ],
            },
          ],
        },
      ],
    };

    expect(projectAgentEventItemsFromOtlpLogs(unsigned, projection)).toEqual([
      null,
    ]);
  });
});

describe("OTLP Instance Health projection", () => {
  test("derives Worker heartbeat and host capacity from standard metrics", () => {
    const projection = projectInstanceTelemetryFromOtlpMetrics({
      resourceMetrics: [
        {
          resource: {
            attributes: [
              attribute("service.name", "eveland-worker"),
              attribute("service.instance.id", "worker_1"),
              attribute("eveland.telemetry.domain", "capacity"),
            ],
          },
          scopeMetrics: [
            {
              metrics: [
                gauge("eveland.worker.heartbeat", [
                  point(1, {
                    "eveland.worker.poll_interval_ms": 5000,
                    "eveland.worker.tick.status": "ok",
                  }),
                ]),
                histogram("eveland.worker.tick.duration", 3, 75),
                gauge("system.cpu.utilization", [
                  point(0.2, {
                    "cpu.logical_number": 0,
                    "cpu.mode": "user",
                  }),
                  point(0.1, {
                    "cpu.logical_number": 0,
                    "cpu.mode": "system",
                  }),
                  point(0.7, {
                    "cpu.logical_number": 0,
                    "cpu.mode": "idle",
                  }),
                ]),
                gauge("system.memory.usage", [
                  point(600, { "system.memory.state": "used" }),
                  point(400, { "system.memory.state": "free" }),
                ]),
                gauge("system.filesystem.usage", [
                  point(700, { "system.filesystem.state": "used" }),
                  point(300, { "system.filesystem.state": "free" }),
                ]),
                gauge("system.filesystem.limit", [point(1000)]),
                gauge("system.filesystem.utilization", [point(0.7)]),
                gauge("eveland.system.filesystem.inodes.usage", [
                  point(80, {
                    "eveland.system.filesystem.inodes.state": "used",
                  }),
                  point(20, {
                    "eveland.system.filesystem.inodes.state": "free",
                  }),
                ]),
                gauge("eveland.system.filesystem.inodes.limit", [point(100)]),
                gauge("eveland.host.load.1m", [point(1.5)]),
              ],
            },
          ],
        },
      ],
    });

    expect(projection).toEqual({
      acceptedDataPoints: 11,
      heartbeats: [
        {
          workerId: "worker_1",
          startedAt: "2026-07-23T11:59:00.000Z",
          observedAt: "2026-07-23T12:00:00.000Z",
          intervalMs: 5000,
          lastTickDurationMs: 25,
          lastError: null,
        },
      ],
      hostMetrics: [
        {
          workerId: "worker_1",
          observedAt: "2026-07-23T12:00:00.000Z",
          cpuPercent: 30,
          load1: 1.5,
          memoryTotalBytes: 1000,
          memoryAvailableBytes: 400,
          diskTotalBytes: 1000,
          diskAvailableBytes: 300,
          diskInodesTotal: 100,
          diskInodesAvailable: 20,
        },
      ],
    });
  });

  test("acknowledges only the DataPoints consumed by each read model", () => {
    const projection = projectInstanceTelemetryFromOtlpMetrics({
      resourceMetrics: [
        {
          resource: {
            attributes: [
              attribute("service.name", "eveland-worker"),
              attribute("service.instance.id", "worker_1"),
              attribute("eveland.telemetry.domain", "capacity"),
            ],
          },
          scopeMetrics: [
            {
              metrics: [
                gauge("eveland.worker.heartbeat", [
                  point(1, {
                    "eveland.worker.poll_interval_ms": 5000,
                  }),
                  point(1, {
                    "eveland.worker.poll_interval_ms": 9000,
                  }),
                ]),
                {
                  name: "eveland.worker.tick.duration",
                  histogram: {
                    dataPoints: [
                      {
                        count: "3",
                        sum: 75,
                        timeUnixNano: "1784808000000000000",
                      },
                      {
                        count: "1",
                        sum: 999,
                        timeUnixNano: "1784808000000000000",
                      },
                    ],
                  },
                },
                gauge("system.filesystem.utilization", [point(0.7)]),
              ],
            },
          ],
        },
      ],
    });

    expect(projection.acceptedDataPoints).toBe(2);
    expect(projection.heartbeats).toEqual([
      expect.objectContaining({
        workerId: "worker_1",
        intervalMs: 5000,
        lastTickDurationMs: 25,
      }),
    ]);
    expect(projection.hostMetrics).toEqual([]);
  });
});

describe("OTLP metric point indexing projection", () => {
  test("indexes standard number, histogram, exponential histogram, and summary points", () => {
    const points = projectOtlpMetricPoints({
      resourceMetrics: [
        {
          resource: {
            attributes: [
              attribute("service.name", "eveland-worker"),
              attribute("eveland.telemetry.domain", "capacity"),
              attribute("eveland.project.id", "proj_1"),
            ],
          },
          scopeMetrics: [
            {
              scope: { name: "@eveland/platform-observability" },
              metrics: [
                {
                  name: "system.memory.usage",
                  description: "Memory usage by state.",
                  unit: "By",
                  gauge: {
                    dataPoints: [
                      point(600, { "system.memory.state": "used" }),
                    ],
                  },
                },
                {
                  name: "eveland.jobs.completed",
                  unit: "{job}",
                  sum: {
                    aggregationTemporality: 2,
                    isMonotonic: true,
                    dataPoints: [
                      {
                        asInt: "12",
                        startTimeUnixNano: "1784807940000000000",
                        timeUnixNano: "1784808000000000000",
                        attributes: [],
                      },
                    ],
                  },
                },
                {
                  name: "eveland.worker.tick.duration",
                  unit: "ms",
                  histogram: {
                    aggregationTemporality: 2,
                    dataPoints: [
                      {
                        count: "3",
                        sum: 75,
                        min: 10,
                        max: 40,
                        bucketCounts: ["1", "2"],
                        explicitBounds: [25],
                        startTimeUnixNano: "1784807940000000000",
                        timeUnixNano: "1784808000000000000",
                        attributes: [],
                      },
                    ],
                  },
                },
                {
                  name: "eveland.request.size",
                  unit: "By",
                  exponentialHistogram: {
                    aggregationTemporality: 1,
                    dataPoints: [
                      {
                        count: "4",
                        sum: 1024,
                        scale: 2,
                        zeroCount: "1",
                        positive: {
                          offset: 1,
                          bucketCounts: ["1", "2"],
                        },
                        startTimeUnixNano: "1784807940000000000",
                        timeUnixNano: "1784808000000000000",
                        attributes: [],
                      },
                    ],
                  },
                },
                {
                  name: "eveland.request.quantiles",
                  unit: "ms",
                  summary: {
                    dataPoints: [
                      {
                        count: "2",
                        sum: 30,
                        quantileValues: [
                          { quantile: 0.5, value: 10 },
                          { quantile: 0.99, value: 20 },
                        ],
                        startTimeUnixNano: "1784807940000000000",
                        timeUnixNano: "1784808000000000000",
                        attributes: [],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    });

    expect(points).toHaveLength(5);
    expect(points).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "system.memory.usage",
          description: "Memory usage by state.",
          unit: "By",
          dataType: "gauge",
          timestamp: "2026-07-23T12:00:00.000Z",
          startTimestamp: "2026-07-23T11:59:00.000Z",
          value: { asDouble: 600 },
          attributes: { "system.memory.state": "used" },
          scopeName: "@eveland/platform-observability",
          resource: expect.objectContaining({
            serviceName: "eveland-worker",
            domain: "capacity",
            projectId: "proj_1",
          }),
        }),
        expect.objectContaining({
          name: "eveland.jobs.completed",
          dataType: "sum",
          aggregationTemporality: 2,
          monotonic: true,
          value: { asInt: 12 },
        }),
        expect.objectContaining({
          name: "eveland.worker.tick.duration",
          dataType: "histogram",
          aggregationTemporality: 2,
          value: {
            count: 3,
            sum: 75,
            min: 10,
            max: 40,
            bucketCounts: [1, 2],
            explicitBounds: [25],
          },
        }),
        expect.objectContaining({
          name: "eveland.request.size",
          dataType: "exponential_histogram",
          value: expect.objectContaining({
            count: 4,
            scale: 2,
            zeroCount: 1,
            positive: { offset: 1, bucketCounts: [1, 2] },
          }),
        }),
        expect.objectContaining({
          name: "eveland.request.quantiles",
          dataType: "summary",
          value: {
            count: 2,
            sum: 30,
            quantileValues: [
              { quantile: 0.5, value: 10 },
              { quantile: 0.99, value: 20 },
            ],
          },
        }),
      ]),
    );
  });

  test("does not index metrics without an Eveland telemetry domain", () => {
    expect(
      projectOtlpMetricPoints({
        resourceMetrics: [
          {
            resource: {
              attributes: [
                attribute("service.name", "user-agent"),
              ],
            },
            scopeMetrics: [],
          },
        ],
      }),
    ).toEqual([]);
  });
});

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

function point(
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
