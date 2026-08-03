import { describe, expect, test, vi } from "vitest";
import { createTestStore } from "@eveland/db/vitest";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Root } from "protobufjs";
import {
  createAgentTelemetryCredential,
  deriveAgentTelemetrySecret,
} from "@eveland/core/server/agent-telemetry-credential";
import { resolvePlatformOtlpServiceToken } from "@eveland/platform-observability";
import { createApp } from "./app.js";

// `createApp` falls back to this key when no APP_SECRET_KEY is configured, so
// credentials minted here verify against the same derived telemetry secret.
const devSecretKey = "eveland-dev-secret-key-000000000";

function agentCredential(deploymentId: string, appSecretKey = devSecretKey): string {
  return createAgentTelemetryCredential(
    { deploymentId, issuedAt: "2026-07-23T12:00:00.000Z" },
    deriveAgentTelemetrySecret(appSecretKey),
  );
}

describe("Built-in OTLP ingest", () => {
  test("uses the development OTLP token when the environment leaves it unset", async () => {
    const previousToken = process.env.EVELAND_OTLP_SERVICE_TOKEN;
    delete process.env.EVELAND_OTLP_SERVICE_TOKEN;

    try {
      const app = createApp(createTestStore());
      const response = await app.request("/internal/otel/v1/traces", {
        method: "POST",
        headers: {
          authorization: `Bearer ${resolvePlatformOtlpServiceToken({})}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ resourceSpans: [] }),
      });

      expect(response.status).toBe(200);
    } finally {
      if (previousToken === undefined) {
        delete process.env.EVELAND_OTLP_SERVICE_TOKEN;
      } else {
        process.env.EVELAND_OTLP_SERVICE_TOKEN = previousToken;
      }
    }
  });

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
    // Only the receipt persists: traces have no Built-in read model.
    await expect(store.latestOtlpBatchReceivedAt({ signal: "traces" })).resolves.toEqual(
      expect.any(String),
    );
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

  test("reports OTLP/HTTP JSON partial success while accepting valid spans", async () => {
    const store = createTestStore();
    const app = createApp(store, {
      otlpServiceToken: "collector-service-token",
    });
    const payload = protobufTraceBatch();
    payload.resourceSpans[0]!.scopeSpans[0]!.spans.push({
      traceId: "AQIDBAUGBwgJCgsMDQ4PEA==",
      spanId: "",
      name: "invalid span",
      startTimeUnixNano: "1784808000000000000",
      endTimeUnixNano: "1784808000125000000",
    });

    const response = await app.request("/internal/otel/v1/traces", {
      method: "POST",
      headers: {
        authorization: "Bearer collector-service-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      partialSuccess: {
        rejectedSpans: "1",
        errorMessage: expect.stringContaining("required"),
      },
    });
    // The rejection count is derived from projection even though nothing is stored.
  });

  test("accepts standard OTLP/HTTP protobuf for every supported signal", async () => {
    const cases = [
      {
        signal: "traces",
        payload: protobufTraceBatch(),
        verify: async () => {
          // Traces persist nothing beyond the receipt asserted in the loop.
        },
      },
      {
        signal: "logs",
        payload: platformLogBatch(),
        verify: async () => {
          // Platform logs are not part of the Built-in read model.
        },
        rejected: 1,
      },
      {
        signal: "metrics",
        payload: workerMetricBatch(),
        verify: async (store: ReturnType<typeof createTestStore>) => {
          await expect(store.listWorkerHeartbeats()).resolves.toEqual([
            expect.objectContaining({ workerId: "worker_1" }),
          ]);
          await expect(
            store.listHostMetrics({
              since: new Date("2026-07-01T00:00:00.000Z"),
              limit: 10,
            }),
          ).resolves.toHaveLength(1);
        },
        rejected: 2,
      },
    ] as const;

    for (const testCase of cases) {
      const store = createTestStore();
      const app = createApp(store, {
        otlpServiceToken: "collector-service-token",
      });
      const response = await app.request(`/internal/otel/v1/${testCase.signal}`, {
        method: "POST",
        headers: {
          authorization: "Bearer collector-service-token",
          "content-type": "application/x-protobuf",
        },
        body: encodeOtlpRequest(testCase.signal, testCase.payload),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/x-protobuf");
      const responseBytes = new Uint8Array(await response.arrayBuffer());
      if ("rejected" in testCase && testCase.rejected > 0) {
        const responseType = protobufResponseTypes[testCase.signal];
        expect(
          responseType.toObject(responseType.decode(responseBytes), {
            longs: String,
          }),
        ).toEqual({
          partialSuccess: {
            [testCase.signal === "logs" ? "rejectedLogRecords" : "rejectedDataPoints"]: String(
              testCase.rejected,
            ),
            errorMessage: expect.stringContaining("required"),
          },
        });
      } else {
        expect(responseBytes).toHaveLength(0);
      }
      await expect(store.latestOtlpBatchReceivedAt({ signal: testCase.signal })).resolves.toEqual(
        expect.any(String),
      );
      await testCase.verify(store);
    }
  });

  test("reports OTLP/HTTP protobuf partial success while accepting valid spans", async () => {
    const store = createTestStore();
    const app = createApp(store, {
      otlpServiceToken: "collector-service-token",
    });
    const payload = protobufTraceBatch();
    payload.resourceSpans[0]!.scopeSpans[0]!.spans.push({
      traceId: "AQIDBAUGBwgJCgsMDQ4PEA==",
      spanId: "",
      name: "invalid span",
      startTimeUnixNano: "1784808000000000000",
      endTimeUnixNano: "1784808000125000000",
    });

    const response = await app.request("/internal/otel/v1/traces", {
      method: "POST",
      headers: {
        authorization: "Bearer collector-service-token",
        "content-type": "application/x-protobuf",
      },
      body: encodeOtlpRequest("traces", payload),
    });

    expect(response.status).toBe(200);
    const responseType = protobufResponseTypes.traces;
    expect(
      responseType.toObject(responseType.decode(new Uint8Array(await response.arrayBuffer())), {
        longs: String,
      }),
    ).toEqual({
      partialSuccess: {
        rejectedSpans: "1",
        errorMessage: expect.stringContaining("required"),
      },
    });
    // The rejection count is derived from projection even though nothing is stored.
  });

  test("rejects malformed OTLP/HTTP protobuf", async () => {
    const app = createApp(createTestStore(), {
      otlpServiceToken: "collector-service-token",
    });
    const response = await app.request("/internal/otel/v1/traces", {
      method: "POST",
      headers: {
        authorization: "Bearer collector-service-token",
        "content-type": "application/x-protobuf",
      },
      body: new Uint8Array([10, 5, 1]).buffer,
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
    // Replaying the batch must not duplicate the Session read model, and the Agent
    // LogRecords themselves are not retained.
    await expect(store.latestOtlpBatchReceivedAt({ signal: "logs" })).resolves.toEqual(
      expect.any(String),
    );
  });

  test("reports Agent LogRecords rejected when the Session projector cannot consume them", async () => {
    const store = createTestStore();
    const app = createApp(store, {
      otlpServiceToken: "collector-service-token",
    });
    const payload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              attribute("service.name", "eveland-agent"),
              attribute("eveland.telemetry.domain", "agent"),
              attribute("eveland.deployment.id", "dep_missing"),
              attribute("eveland.deployment.credential", agentCredential("dep_missing")),
            ],
          },
          scopeLogs: [
            {
              scope: { name: "@eveland/eve-runtime" },
              logRecords: [
                {
                  timeUnixNano: "1784808000000000000",
                  body: { stringValue: "not an Eve event" },
                },
              ],
            },
          ],
        },
      ],
    };

    const response = await app.request("/internal/otel/v1/logs", {
      method: "POST",
      headers: {
        authorization: "Bearer collector-service-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      partialSuccess: {
        rejectedLogRecords: "1",
        errorMessage: expect.stringContaining("required"),
      },
    });
  });

  test("refuses Agent telemetry that claims another Deployment than its credential", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Victim",
      importKind: "zip",
    });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/otlp-victim",
      summary: { eveVersion: "0.27.0" },
      envVars: [],
      files: [],
      schedules: [],
    });
    const victim = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/otlp-victim:test",
      containerName: "eveland-otlp-victim",
      internalPort: 3000,
      hostPort: 41000,
      runtimeKind: "docker",
    });
    const app = createApp(store, {
      otlpServiceToken: "collector-service-token",
    });

    // A batch signed for one Deployment but naming the victim's id in the
    // unauthenticated `eveland.deployment.id` attribute.
    const forged = agentLogBatch(victim.id);
    forged.resourceLogs[0]!.resource.attributes = [
      attribute("service.name", "eveland-agent"),
      attribute("eveland.telemetry.domain", "agent"),
      attribute("eveland.deployment.id", victim.id),
      attribute("eveland.deployment.credential", agentCredential("dep_other")),
    ];

    const response = await app.request("/internal/otel/v1/logs", {
      method: "POST",
      headers: {
        authorization: "Bearer collector-service-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(forged),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      partialSuccess: {
        rejectedLogRecords: "2",
        errorMessage: expect.stringContaining("required"),
      },
    });
    await expect(store.listSessions(project.id)).resolves.toEqual([]);
  });

  test("reports valid Agent events rejected when their Deployment is unmanaged", async () => {
    const app = createApp(createTestStore(), {
      otlpServiceToken: "collector-service-token",
    });

    const response = await app.request("/internal/otel/v1/logs", {
      method: "POST",
      headers: {
        authorization: "Bearer collector-service-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(agentLogBatch("dep_unmanaged")),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      partialSuccess: {
        rejectedLogRecords: "2",
        errorMessage: expect.stringContaining("required"),
      },
    });
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
    // Capacity metrics leave behind these read models only; the points themselves are
    // not retained anywhere.
  });

  test("reports metric points rejected when the Instance Health projector cannot consume them", async () => {
    const app = createApp(createTestStore(), {
      otlpServiceToken: "collector-service-token",
    });
    const payload = {
      resourceMetrics: [
        {
          resource: {
            attributes: [
              attribute("service.name", "eveland-api"),
              attribute("eveland.telemetry.domain", "platform"),
              attribute("service.instance.id", "api_1"),
            ],
          },
          scopeMetrics: [
            {
              metrics: [gauge("http.server.request.duration", [metricPoint(10)])],
            },
          ],
        },
      ],
    };

    const response = await app.request("/internal/otel/v1/metrics", {
      method: "POST",
      headers: {
        authorization: "Bearer collector-service-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      partialSuccess: {
        rejectedDataPoints: "1",
        errorMessage: expect.stringContaining("required"),
      },
    });
  });
});

describe("external OTLP egress proxy", () => {
  /**
   * Production always configures `options.auth`; before this test nothing in
   * apps/api did, so the catch-all session middleware never ran under test and
   * a route registered behind it would 401 the Collector only in production.
   */
  test("stays reachable with the Collector service token when session auth is enabled", async () => {
    const store = createTestStore();
    const authenticate = vi.fn().mockResolvedValue(null);
    const app = createApp(store, {
      appSecretKey: "0123456789abcdef0123456789abcdef",
      otlpServiceToken: "collector-service-token",
      auth: { authenticate } as unknown as NonNullable<Parameters<typeof createApp>[1]>["auth"],
    });

    const response = await app.request("/internal/observability/destinations/dst_missing/v1/logs", {
      method: "POST",
      headers: {
        authorization: "Bearer collector-service-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ resourceLogs: [] }),
    });

    // 404 is the route's own "no such destination" answer, proving the handler
    // ran. A 401 here would mean the session middleware intercepted it.
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    expect(authenticate).not.toHaveBeenCalled();
  });

  test("authenticates Collector traffic and forwards through the validated requester", async () => {
    const store = createTestStore();
    const forwardExternalObservabilityRequest = vi.fn().mockResolvedValue({
      status: 202,
      contentType: "application/json",
      body: new Uint8Array(),
    });
    const app = createApp(store, {
      appSecretKey: "0123456789abcdef0123456789abcdef",
      otlpServiceToken: "collector-service-token",
      validateObservabilityDestination: async () => undefined,
      forwardExternalObservabilityRequest,
    });
    const created = await app.request("/system/observability/destinations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 1,
        config: {
          kind: "custom_otlp",
          endpoint: "https://collector.example",
          supportedSignals: ["logs"],
          domains: ["agent"],
          headers: { "x-api-key": "destination-secret" },
        },
      }),
    });
    expect(created.status).toBe(201);
    const destinationId = (await store.getObservabilityPolicy("team_local"))
      .externalDestinations[0]!.id;
    const body = JSON.stringify({ resourceLogs: [] });

    const hidden = await app.request(
      `/internal/observability/destinations/${destinationId}/v1/logs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      },
    );
    expect(hidden.status).toBe(404);

    const response = await app.request(
      `/internal/observability/destinations/${destinationId}/v1/logs`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer collector-service-token",
          "content-type": "application/json",
        },
        body,
      },
    );

    expect(response.status).toBe(202);
    expect(forwardExternalObservabilityRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          endpoint: "https://collector.example",
          headers: { "x-api-key": "destination-secret" },
        }),
        signal: "logs",
        contentType: "application/json",
        body: new Uint8Array(Buffer.from(body)),
      }),
    );
  });

  test("enforces the current destination domains while Collector configuration is stale", async () => {
    const store = createTestStore();
    const forwardExternalObservabilityRequest = vi.fn().mockResolvedValue({
      status: 200,
      contentType: "application/json",
      body: new Uint8Array(),
    });
    const app = createApp(store, {
      appSecretKey: devSecretKey,
      otlpServiceToken: "collector-service-token",
      validateObservabilityDestination: async () => undefined,
      forwardExternalObservabilityRequest,
    });
    const created = await app.request("/system/observability/destinations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 1,
        config: {
          kind: "custom_otlp",
          endpoint: "https://collector.example",
          supportedSignals: ["logs"],
          domains: ["platform", "capacity"],
          headers: {},
        },
      }),
    });
    expect(created.status).toBe(201);
    const destinationId = (await store.getObservabilityPolicy("team_local"))
      .externalDestinations[0]!.id;
    const updated = await app.request(`/system/observability/destinations/${destinationId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 2,
        config: {
          kind: "custom_otlp",
          endpoint: "https://collector.example",
          supportedSignals: ["logs"],
          domains: ["capacity"],
        },
      }),
    });
    expect(updated.status).toBe(200);

    const response = await app.request(
      `/internal/observability/destinations/${destinationId}/v1/logs`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer collector-service-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          resourceLogs: [
            platformLogBatch().resourceLogs[0],
            {
              resource: {
                attributes: [
                  attribute("service.name", "eveland-worker"),
                  attribute("eveland.telemetry.domain", "capacity"),
                ],
              },
              scopeLogs: [],
            },
          ],
        }),
      },
    );

    expect(response.status).toBe(200);
    const forwarded = JSON.parse(
      new TextDecoder().decode(forwardExternalObservabilityRequest.mock.calls[0]![0].body),
    );
    expect(
      forwarded.resourceLogs.map(
        (resourceLog: {
          resource: {
            attributes: Array<{
              key: string;
              value: { stringValue?: string };
            }>;
          };
        }) => readStringAttributes(resourceLog.resource.attributes)["eveland.telemetry.domain"],
      ),
    ).toEqual(["capacity"]);
  });

  test("binds Agent telemetry to the signed Deployment and strips the credential before forwarding", async () => {
    const store = createTestStore();
    const attackerProject = await store.createProject({
      name: "Attacker",
      importKind: "zip",
    });
    const attackerRevision = await store.recordSourceRevision({
      projectId: attackerProject.id,
      kind: "zip",
      sourcePath: "/tmp/otlp-attacker",
      summary: { eveVersion: "0.27.0" },
      envVars: [],
      files: [],
      schedules: [],
    });
    const attacker = await store.recordDeployment({
      projectId: attackerProject.id,
      sourceRevisionId: attackerRevision.id,
      imageTag: "eveland/otlp-attacker:test",
      containerName: "eveland-otlp-attacker",
      internalPort: 3000,
      hostPort: 41000,
      runtimeKind: "systemd",
    });
    const victimProject = await store.createProject({
      name: "Victim",
      importKind: "zip",
    });
    const victimRevision = await store.recordSourceRevision({
      projectId: victimProject.id,
      kind: "zip",
      sourcePath: "/tmp/otlp-victim",
      summary: { eveVersion: "0.27.0" },
      envVars: [],
      files: [],
      schedules: [],
    });
    const victim = await store.recordDeployment({
      projectId: victimProject.id,
      sourceRevisionId: victimRevision.id,
      imageTag: "eveland/otlp-victim:test",
      containerName: "eveland-otlp-victim",
      internalPort: 3000,
      hostPort: 41001,
      runtimeKind: "docker",
    });
    const forwardExternalObservabilityRequest = vi.fn().mockResolvedValue({
      status: 200,
      contentType: "application/json",
      body: new Uint8Array(),
    });
    const app = createApp(store, {
      appSecretKey: devSecretKey,
      otlpServiceToken: "collector-service-token",
      validateObservabilityDestination: async () => undefined,
      forwardExternalObservabilityRequest,
    });
    await app.request("/system/observability/destinations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 1,
        config: {
          kind: "custom_otlp",
          endpoint: "https://collector.example",
          supportedSignals: ["logs"],
          domains: ["agent"],
          headers: {},
        },
      }),
    });
    const destinationId = (await store.getObservabilityPolicy("team_local"))
      .externalDestinations[0]!.id;
    const payload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              attribute("service.name", "eveland-agent"),
              attribute("eveland.telemetry.domain", "agent"),
              attribute("eveland.team.id", "team_victim"),
              attribute("eveland.project.id", victim.projectId),
              attribute("eveland.release.id", victim.releaseId),
              attribute("eveland.deployment.id", victim.id),
              attribute("eveland.runtime.kind", "docker"),
              attribute("eveland.deployment.credential", agentCredential(attacker.id)),
            ],
          },
          scopeLogs: [
            {
              scope: { name: "@eveland/eve-runtime" },
              logRecords: [
                {
                  attributes: [
                    attribute("eveland.project.id", victim.projectId),
                    attribute("langfuse.observation.metadata.eveland.project_id", victim.projectId),
                    attribute("eveland.deployment.credential", agentCredential(attacker.id)),
                  ],
                  body: { stringValue: "event" },
                },
              ],
            },
          ],
        },
      ],
    };

    const response = await app.request(
      `/internal/observability/destinations/${destinationId}/v1/logs`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer collector-service-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    expect(response.status).toBe(200);
    const forwarded = JSON.parse(
      new TextDecoder().decode(forwardExternalObservabilityRequest.mock.calls[0]![0].body),
    );
    const resourceAttributes = forwarded.resourceLogs[0].resource.attributes;
    expect(readStringAttributes(resourceAttributes)).toMatchObject({
      "service.name": "eveland-agent",
      "eveland.telemetry.domain": "agent",
      "eveland.team.id": "team_local",
      "eveland.project.id": attacker.projectId,
      "eveland.release.id": attacker.releaseId,
      "eveland.deployment.id": attacker.id,
      "eveland.runtime.kind": "systemd",
    });
    expect(readStringAttributes(resourceAttributes)).not.toHaveProperty(
      "eveland.deployment.credential",
    );
    expect(
      readStringAttributes(forwarded.resourceLogs[0].scopeLogs[0].logRecords[0].attributes),
    ).toMatchObject({
      "eveland.project.id": attacker.projectId,
      "langfuse.observation.metadata.eveland.project_id": attacker.projectId,
    });
    expect(JSON.stringify(forwarded)).not.toContain("eveland.deployment.credential");
  });

  test("drops Agent resources whose deployment credential cannot be verified", async () => {
    const store = createTestStore();
    const forwardExternalObservabilityRequest = vi.fn().mockResolvedValue({
      status: 200,
      contentType: "application/json",
      body: new Uint8Array(),
    });
    const app = createApp(store, {
      appSecretKey: devSecretKey,
      otlpServiceToken: "collector-service-token",
      validateObservabilityDestination: async () => undefined,
      forwardExternalObservabilityRequest,
    });
    await app.request("/system/observability/destinations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 1,
        config: {
          kind: "custom_otlp",
          endpoint: "https://collector.example",
          supportedSignals: ["logs"],
          domains: ["agent"],
          headers: {},
        },
      }),
    });
    const destinationId = (await store.getObservabilityPolicy("team_local"))
      .externalDestinations[0]!.id;

    const response = await app.request(
      `/internal/observability/destinations/${destinationId}/v1/logs`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer collector-service-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          resourceLogs: [
            {
              resource: {
                attributes: [
                  attribute("eveland.telemetry.domain", "agent"),
                  attribute("eveland.deployment.credential", "forged.signature"),
                ],
              },
              scopeLogs: [],
            },
          ],
        }),
      },
    );

    expect(response.status).toBe(200);
    const forwarded = JSON.parse(
      new TextDecoder().decode(forwardExternalObservabilityRequest.mock.calls[0]![0].body),
    );
    expect(forwarded).toEqual({ resourceLogs: [] });
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
            attribute("eveland.deployment.credential", agentCredential(deploymentId)),
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

function protobufTraceBatch() {
  return {
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
                traceId: "AQIDBAUGBwgJCgsMDQ4PEA==",
                spanId: "AQIDBAUGBwg=",
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
}

function platformLogBatch() {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            attribute("service.name", "eveland-worker"),
            attribute("eveland.telemetry.domain", "platform"),
          ],
        },
        scopeLogs: [
          {
            scope: { name: "test" },
            logRecords: [
              {
                timeUnixNano: "1784808000000000000",
                traceId: "AQIDBAUGBwgJCgsMDQ4PEA==",
                spanId: "AQIDBAUGBwg=",
                severityNumber: 9,
                severityText: "INFO",
                body: { stringValue: "worker ready" },
              },
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

function readStringAttributes(attributes: Array<{ key: string; value: { stringValue?: string } }>) {
  return Object.fromEntries(attributes.map(({ key, value }) => [key, value.stringValue]));
}

function anyValue(value: unknown): Record<string, unknown> {
  if (value === null) return {};
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === "boolean") return { boolValue: value };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(anyValue) } };
  }
  return {
    kvlistValue: {
      values: Object.entries(value as Record<string, unknown>).map(([key, child]) => ({
        key,
        value: anyValue(child),
      })),
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

function gauge(name: string, dataPoints: Array<Record<string, unknown>>) {
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

function metricPoint(value: number, attributes: Record<string, string | number> = {}) {
  return {
    asDouble: value,
    startTimeUnixNano: "1784807940000000000",
    timeUnixNano: "1784808000000000000",
    attributes: Object.entries(attributes).map(([key, child]) => ({
      key,
      value: typeof child === "number" ? { intValue: String(child) } : { stringValue: child },
    })),
  };
}

const otlpProtoRootDirectory = fileURLToPath(
  new URL("../../../packages/session-collector/proto/", import.meta.url),
);
const otlpProtoRoot = new Root();
otlpProtoRoot.resolvePath = (_origin, target) => resolve(otlpProtoRootDirectory, target);
otlpProtoRoot.loadSync([
  resolve(otlpProtoRootDirectory, "opentelemetry/proto/collector/trace/v1/trace_service.proto"),
  resolve(otlpProtoRootDirectory, "opentelemetry/proto/collector/logs/v1/logs_service.proto"),
  resolve(otlpProtoRootDirectory, "opentelemetry/proto/collector/metrics/v1/metrics_service.proto"),
]);

const protobufRequestTypes = {
  traces: otlpProtoRoot.lookupType(
    "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
  ),
  logs: otlpProtoRoot.lookupType("opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest"),
  metrics: otlpProtoRoot.lookupType(
    "opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest",
  ),
};

const protobufResponseTypes = {
  traces: otlpProtoRoot.lookupType(
    "opentelemetry.proto.collector.trace.v1.ExportTraceServiceResponse",
  ),
  logs: otlpProtoRoot.lookupType("opentelemetry.proto.collector.logs.v1.ExportLogsServiceResponse"),
  metrics: otlpProtoRoot.lookupType(
    "opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceResponse",
  ),
};

function encodeOtlpRequest(
  signal: keyof typeof protobufRequestTypes,
  payload: object,
): ArrayBuffer {
  const type = protobufRequestTypes[signal];
  const bytes = type.encode(type.fromObject(payload)).finish();
  return Uint8Array.from(bytes).buffer;
}
