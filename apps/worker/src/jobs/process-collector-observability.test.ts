import {
  createDefaultObservabilityPolicy,
  type ObservabilityPolicy,
} from "@eveland/core/observability";
import { encryptSecretValue } from "@eveland/core/server/secrets";
import { createTestStore } from "@eveland/db/vitest";
import { DEFAULT_TEAM_ID } from "@eveland/db";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, test } from "vitest";
import {
  createCollectorObservabilityReconciler,
  renderCollectorConfig,
} from "./process-collector-observability.js";

const appSecretKey = "eveland-dev-secret-key-000000000";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("managed OpenTelemetry Collector configuration", () => {
  test("keeps the Compose seed aligned with the default managed config", async () => {
    const seed = parse(
      await readFile(
        path.resolve(
          import.meta.dirname,
          "../../../../infra/otel/collector.yaml",
        ),
        "utf8",
      ),
    );
    const managed = parse(
      renderCollectorConfig({
        policy: createDefaultObservabilityPolicy(1),
        appSecretKey,
      }),
    );

    expect(seed).toEqual(managed);
  });

  test("keeps Built-in enabled when no external destination is configured", () => {
    const config = parse(
      renderCollectorConfig({
        policy: createDefaultObservabilityPolicy(1),
        appSecretKey,
      }),
    );

    expect(config.exporters["otlp_http/builtin"]).toMatchObject({
      endpoint: "${env:EVELAND_BUILTIN_OTLP_ENDPOINT}",
      compression: "none",
    });
    expect(config.exporters["otlp_http/builtin"]).not.toHaveProperty(
      "encoding",
    );
    expect(config.service.pipelines).toMatchObject({
      traces: {
        processors: [
          "memory_limiter",
          "filter/builtin_eveland",
          "batch",
        ],
        exporters: ["otlp_http/builtin"],
      },
      logs: {
        processors: [
          "memory_limiter",
          "filter/builtin_eveland",
          "batch",
        ],
        exporters: ["otlp_http/builtin"],
      },
      metrics: {
        processors: [
          "memory_limiter",
          "filter/builtin_eveland",
          "batch",
        ],
        exporters: ["otlp_http/builtin"],
      },
      "metrics/collector_self": {
        receivers: ["prometheus/collector_self"],
        processors: [
          "memory_limiter",
          "resource/collector_self",
          "batch",
        ],
        exporters: ["otlp_http/builtin"],
      },
    });
    expect(config.receivers["prometheus/collector_self"]).toMatchObject({
      config: {
        scrape_configs: [
          expect.objectContaining({
            job_name: "eveland-otel-collector",
            static_configs: [{ targets: ["127.0.0.1:8888"] }],
          }),
        ],
      },
    });
    expect(config.processors["resource/collector_self"]).toMatchObject({
      attributes: expect.arrayContaining([
        {
          key: "service.name",
          value: "eveland-otel-collector",
          action: "upsert",
        },
        {
          key: "eveland.telemetry.domain",
          value: "platform",
          action: "upsert",
        },
      ]),
    });
    expect(config.service.telemetry).toMatchObject({
      metrics: {
        level: "detailed",
        readers: [
          {
            pull: {
              exporter: {
                prometheus: {
                  host: "127.0.0.1",
                  port: 8888,
                  without_type_suffix: true,
                  without_units: true,
                },
              },
            },
          },
        ],
      },
    });
    expect(
      config.processors["filter/builtin_eveland"].trace_conditions,
    ).toEqual([
      'resource.attributes["eveland.telemetry.domain"] != "agent" and resource.attributes["eveland.telemetry.domain"] != "platform" and resource.attributes["eveland.telemetry.domain"] != "runtime" and resource.attributes["eveland.telemetry.domain"] != "capacity"',
    ]);
  });

  test("builds isolated exporters, filters, and pipelines for enabled destinations", () => {
    const policy: ObservabilityPolicy = {
      ...createDefaultObservabilityPolicy(4),
      externalDestinations: [
        {
          id: "destination_elastic",
          kind: "elastic",
          enabled: true,
          securityRevision: 1,
          encryptedConfig: encrypted({
            kind: "elastic",
            endpoint: "https://elastic.example.com:4318",
            authorization: { type: "api_key", value: "elastic-secret" },
          }),
          supportedSignals: ["traces", "logs", "metrics"],
          filterProfile: "all_eveland",
        },
        {
          id: "destination_langfuse",
          kind: "langfuse",
          enabled: true,
          securityRevision: 1,
          encryptedConfig: encrypted({
            kind: "langfuse",
            tracesEndpoint:
              "https://langfuse.example.com/api/public/otel/v1/traces",
            publicKey: "pk-lf-test",
            secretKey: "sk-lf-test",
          }),
          supportedSignals: ["traces"],
          filterProfile: "agent_genai",
        },
        {
          id: "destination_custom",
          kind: "custom_otlp",
          enabled: true,
          securityRevision: 1,
          encryptedConfig: encrypted({
            kind: "custom_otlp",
            endpoint: "https://otel.example.com",
            supportedSignals: ["logs", "metrics"],
            domains: ["platform", "capacity"],
            headers: { "x-api-key": "custom-secret" },
          }),
          supportedSignals: ["logs", "metrics"],
          domains: ["platform", "capacity"],
          filterProfile: "custom",
        },
        {
          id: "destination_paused",
          kind: "custom_otlp",
          enabled: false,
          securityRevision: 1,
          encryptedConfig: encrypted({
            kind: "custom_otlp",
            endpoint: "https://paused.example.com",
            supportedSignals: ["traces"],
            domains: ["agent"],
            headers: {},
          }),
          supportedSignals: ["traces"],
          domains: ["agent"],
          filterProfile: "custom",
        },
      ],
    };

    const config = parse(renderCollectorConfig({ policy, appSecretKey }));

    expect(config.exporters["otlp_http/destination_elastic"]).toMatchObject({
      endpoint: "https://elastic.example.com:4318",
      headers: { authorization: "ApiKey elastic-secret" },
      sending_queue: {
        enabled: true,
        storage: "file_storage",
      },
    });
    expect(config.exporters["otlp_http/destination_langfuse"]).toMatchObject({
      traces_endpoint:
        "https://langfuse.example.com/api/public/otel/v1/traces",
      headers: {
        authorization: `Basic ${Buffer.from(
          "pk-lf-test:sk-lf-test",
        ).toString("base64")}`,
        "x-langfuse-ingestion-version": "4",
      },
    });
    expect(config.exporters["otlp_http/destination_custom"]).toMatchObject({
      endpoint: "https://otel.example.com",
      headers: { "x-api-key": "custom-secret" },
    });
    expect(config.exporters).not.toHaveProperty(
      "otlp_http/destination_paused",
    );

    expect(
      config.processors["filter/destination_langfuse"].trace_conditions,
    ).toEqual([
      'resource.attributes["eveland.telemetry.domain"] != "agent"',
    ]);
    expect(
      config.processors[
        "transform/langfuse_destination_langfuse"
      ].trace_statements[0].statements,
    ).toContain(
      'set(span.attributes["langfuse.session.id"], span.attributes["session.id"]) where span.attributes["session.id"] != nil',
    );
    expect(
      config.service.pipelines[
        "traces/langfuse_destination_langfuse"
      ].processors,
    ).toEqual([
      "memory_limiter",
      "filter/destination_langfuse",
      "transform/langfuse_destination_langfuse",
      "batch",
    ]);
    expect(
      config.processors["filter/destination_custom"].log_conditions,
    ).toEqual([
      'resource.attributes["eveland.telemetry.domain"] != "platform" and resource.attributes["eveland.telemetry.domain"] != "capacity"',
    ]);
    expect(config.service.pipelines).toHaveProperty(
      "traces/elastic_destination_elastic",
    );
    expect(
      config.service.pipelines[
        "traces/elastic_destination_elastic"
      ].processors,
    ).toContain("filter/destination_elastic");
    expect(config.service.pipelines).toHaveProperty(
      "traces/langfuse_destination_langfuse",
    );
    expect(config.service.pipelines).not.toHaveProperty(
      "traces/custom_destination_custom",
    );
    expect(config.service.pipelines).toHaveProperty(
      "logs/custom_destination_custom",
    );
    expect(config.service.pipelines).toHaveProperty(
      "metrics/custom_destination_custom",
    );
    expect(config.service.pipelines).toMatchObject({
      "metrics/collector_self_elastic_destination_elastic": {
        receivers: ["prometheus/collector_self"],
        processors: [
          "memory_limiter",
          "resource/collector_self",
          "batch",
        ],
        exporters: ["otlp_http/destination_elastic"],
      },
      "metrics/collector_self_custom_destination_custom": {
        receivers: ["prometheus/collector_self"],
        processors: [
          "memory_limiter",
          "resource/collector_self",
          "batch",
        ],
        exporters: ["otlp_http/destination_custom"],
      },
    });
  });

  test("validates and applies a policy revision once without restarting Agents", async () => {
    const store = createTestStore();
    const dataDir = path.join(
      os.tmpdir(),
      `eveland-collector-policy-${Date.now()}`,
    );
    temporaryDirectories.push(dataDir);
    const calls: string[] = [];
    const reconcile = createCollectorObservabilityReconciler({
      store,
      env: {
        APP_SECRET_KEY: appSecretKey,
        EVELAND_DATA_DIR: dataDir,
        EVELAND_HOST_DATA_DIR: dataDir,
      },
      validateConfig: async ({ workerPath }) => {
        calls.push(`validate:${workerPath}`);
        expect(await readFile(workerPath, "utf8")).toContain(
          "otlp_http/builtin",
        );
      },
      restartCollector: async () => {
        calls.push("restart");
      },
    });

    await expect(reconcile()).resolves.toBe(1);
    await expect(reconcile()).resolves.toBe(0);

    expect(calls).toEqual([
      `validate:${path.join(dataDir, "otel", "collector.yaml.candidate")}`,
      "restart",
    ]);
    await expect(
      readFile(path.join(dataDir, "otel", "collector.yaml"), "utf8"),
    ).resolves.toContain("otlp_http/builtin");
  });

  test.runIf(process.env.EVELAND_VALIDATE_OTEL_COLLECTOR === "1")(
    "passes the official Collector validation command",
    async () => {
      const store = createTestStore();
      await store.saveObservabilityPolicy({
        teamId: DEFAULT_TEAM_ID,
        expectedRevision: 1,
        agentCapture: createDefaultObservabilityPolicy(1).agentCapture,
        externalDestinations: [
          {
            id: "destination_validation",
            kind: "langfuse",
            enabled: true,
            securityRevision: 1,
            encryptedConfig: encrypted({
              kind: "langfuse",
              tracesEndpoint:
                "https://langfuse.example.com/api/public/otel/v1/traces",
              publicKey: "pk-lf-validation",
              secretKey: "sk-lf-validation",
            }),
            supportedSignals: ["traces"],
            filterProfile: "agent_genai",
          },
        ],
      });
      const dataDir = path.join(
        os.tmpdir(),
        `eveland-collector-validation-${Date.now()}`,
      );
      temporaryDirectories.push(dataDir);
      const reconcile = createCollectorObservabilityReconciler({
        store,
        env: {
          APP_SECRET_KEY: appSecretKey,
          EVELAND_DATA_DIR: dataDir,
          EVELAND_HOST_DATA_DIR: dataDir,
        },
        restartCollector: async () => undefined,
      });

      await expect(reconcile()).resolves.toBe(1);
    },
  );
});

function encrypted(config: unknown): string {
  return JSON.stringify(
    encryptSecretValue(JSON.stringify(config), appSecretKey),
  );
}
