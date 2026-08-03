import { describe, expect, test } from "vitest";
import {
  projectAgentEventItemsFromOtlpLogs,
  projectAgentEventsFromOtlpLogs,
  projectInstanceTelemetryFromOtlpMetrics,
} from "../otlp.js";
import { anyValue, attribute, gauge, histogram, point } from "./test-support.js";

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

    expect(projectAgentEventItemsFromOtlpLogs(payload, projection)).toEqual([null]);
    expect(projectAgentEventsFromOtlpLogs(payload, projection)).toEqual([]);
  });

  test("maps standard OTLP/HTTP JSON LogRecords to Session observations", () => {
    const observations = projectAgentEventsFromOtlpLogs(
      {
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
                      attribute("eveland.eve.parent_session.id", "eve_parent_1"),
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
      },
      projection,
    );

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
      projectAgentEventsFromOtlpLogs(
        {
          resourceLogs: [
            {
              resource: {
                attributes: [attribute("eveland.telemetry.domain", "platform")],
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
        },
        projection,
      ),
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

    expect(projectAgentEventItemsFromOtlpLogs(unsigned, projection)).toEqual([null]);
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
                    "eveland.worker.max_concurrent_heavy_jobs": 4,
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
                gauge("eveland.host.cpu.logical.count", [point(4)]),
                gauge("eveland.postgres.connections.usage", [
                  point(42, { "eveland.postgres.role": "shared" }),
                ]),
                gauge("eveland.postgres.connections.limit", [
                  point(100, { "eveland.postgres.role": "shared" }),
                ]),
                gauge("eveland.postgres.agent_pool_size", [
                  point(10, { "eveland.postgres.role": "shared" }),
                ]),
              ],
            },
          ],
        },
      ],
    });

    expect(projection).toEqual({
      acceptedDataPoints: 15,
      heartbeats: [
        {
          workerId: "worker_1",
          startedAt: "2026-07-23T11:59:00.000Z",
          observedAt: "2026-07-23T12:00:00.000Z",
          intervalMs: 5000,
          lastTickDurationMs: 25,
          lastError: null,
          maxConcurrentHeavyJobs: 4,
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
          cpuCores: 4,
          pgConnections: [
            { role: "shared", usedConnections: 42, maxConnections: 100, agentPoolSize: 10 },
          ],
        },
      ],
    });
  });

  test("keeps spec fields null for workers that predate them", () => {
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
                gauge("system.memory.usage", [
                  point(600, { "system.memory.state": "used" }),
                  point(400, { "system.memory.state": "free" }),
                ]),
                gauge("system.filesystem.usage", [
                  point(300, { "system.filesystem.state": "free" }),
                ]),
                gauge("system.filesystem.limit", [point(1000)]),
              ],
            },
          ],
        },
      ],
    });

    expect(projection.hostMetrics).toEqual([
      expect.objectContaining({ cpuCores: null, pgConnections: null }),
    ]);
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
        // Workers that predate the heavy-job cap publish no cap attribute.
        maxConcurrentHeavyJobs: null,
      }),
    ]);
    expect(projection.hostMetrics).toEqual([]);
  });
});
