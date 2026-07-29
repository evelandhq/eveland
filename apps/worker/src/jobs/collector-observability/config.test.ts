import {
  createDefaultObservabilityPolicy,
  type ObservabilityPolicy,
} from "@eveland/core/observability";
import { encryptSecretValue } from "@eveland/core/server/secrets";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, test } from "vitest";
import { renderCollectorConfig } from "./config.js";
import {
  collectorAppSecretKey as appSecretKey,
  encryptedCollectorConfig as encrypted,
} from "./test-support.js";

describe("managed OpenTelemetry Collector configuration", () => {
  test("keeps the Compose seed aligned with the default managed config", async () => {
    const seed = parse(
      await readFile(
        path.resolve(
          import.meta.dirname,
          "../../../../../infra/otel/collector.yaml",
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
    expect(config.extensions["bearertokenauth/platform"]).toEqual({
      token: "${env:EVELAND_OTLP_SERVICE_TOKEN}",
    });
    expect(config.receivers["otlp/platform"]).toMatchObject({
      protocols: {
        grpc: {
          endpoint: "0.0.0.0:4317",
          auth: { authenticator: "bearertokenauth/platform" },
        },
        http: {
          endpoint: "0.0.0.0:4318",
          auth: { authenticator: "bearertokenauth/platform" },
        },
      },
    });
    expect(config.receivers["otlp/agent"]).toMatchObject({
      protocols: {
        grpc: { endpoint: "0.0.0.0:4327" },
        http: { endpoint: "0.0.0.0:4328" },
      },
    });
    expect(config.processors["resource/trusted_agent"]).toEqual({
      attributes: [
        {
          key: "service.name",
          value: "eveland-agent",
          action: "upsert",
        },
        {
          key: "eveland.telemetry.domain",
          value: "agent",
          action: "upsert",
        },
      ],
    });
    expect(config.processors["filter/trusted_agent"]).toMatchObject({
      trace_conditions: [
        'scope.name != "@eveland/eve-runtime"',
      ],
      log_conditions: [
        'scope.name != "@eveland/eve-runtime"',
      ],
      metric_conditions: [
        'scope.name != "@eveland/eve-runtime"',
      ],
    });
    // No builtin traces pipeline: Built-in keeps no span read model, so spans go to
    // external destinations only.
    expect(config.service.pipelines).not.toHaveProperty("traces");
    expect(config.service.pipelines).toMatchObject({
      logs: {
        receivers: ["otlp/agent"],
        processors: [
          "memory_limiter",
          "resource/trusted_agent",
          "filter/trusted_agent",
          "batch",
        ],
        exporters: ["otlp_http/builtin"],
      },
      metrics: {
        receivers: ["otlp/platform"],
        processors: [
          "memory_limiter",
          "filter/builtin_capacity",
          "batch",
        ],
        exporters: ["otlp_http/builtin"],
      },
    });
    // The Collector's own metrics never reach Built-in: no self-metrics pipeline
    // exports to it. They are only forwarded to external destinations that take
    // metrics for the platform domain.
    expect(config.service.pipelines).not.toHaveProperty(
      "metrics/collector_self",
    );
    expect(config.processors).not.toHaveProperty("filter/collector_self");
    expect(config.service.telemetry.metrics.level).toBe("normal");
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
        level: "normal",
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
    expect(config.processors["filter/builtin_capacity"]).toEqual({
      error_mode: "ignore",
      metric_conditions: [
        'resource.attributes["service.name"] != "eveland-worker" or resource.attributes["eveland.telemetry.domain"] != "capacity"',
        [
          'metric.name != "eveland.worker.heartbeat"',
          'metric.name != "eveland.worker.tick.duration"',
          'metric.name != "system.cpu.utilization"',
          'metric.name != "system.memory.usage"',
          'metric.name != "system.filesystem.usage"',
          'metric.name != "system.filesystem.limit"',
          'metric.name != "eveland.system.filesystem.inodes.usage"',
          'metric.name != "eveland.system.filesystem.inodes.limit"',
          'metric.name != "eveland.host.load.1m"',
        ].join(" and "),
        'metric.name == "system.cpu.utilization" and datapoint.attributes["cpu.mode"] == "idle"',
        'metric.name == "system.memory.usage" and datapoint.attributes["system.memory.state"] != "used" and datapoint.attributes["system.memory.state"] != "free"',
        'metric.name == "system.filesystem.usage" and datapoint.attributes["system.filesystem.state"] != "free"',
        'metric.name == "eveland.system.filesystem.inodes.usage" and datapoint.attributes["eveland.system.filesystem.inodes.state"] != "free"',
      ],
    });
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
            baseUrl: "https://langfuse.example.com",
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
      endpoint:
        "${env:EVELAND_EXTERNAL_OTLP_PROXY_ENDPOINT}/destination_elastic",
      headers: {
        authorization: "Bearer ${env:EVELAND_OTLP_SERVICE_TOKEN}",
      },
      compression: "none",
      sending_queue: {
        enabled: true,
        storage: "file_storage",
      },
    });
    expect(config.exporters["otlp_http/destination_langfuse"]).toMatchObject({
      traces_endpoint:
        "${env:EVELAND_EXTERNAL_OTLP_PROXY_ENDPOINT}/destination_langfuse/v1/traces",
      headers: {
        authorization: "Bearer ${env:EVELAND_OTLP_SERVICE_TOKEN}",
      },
      compression: "none",
    });
    expect(config.exporters["otlp_http/destination_custom"]).toMatchObject({
      endpoint:
        "${env:EVELAND_EXTERNAL_OTLP_PROXY_ENDPOINT}/destination_custom",
      headers: {
        authorization: "Bearer ${env:EVELAND_OTLP_SERVICE_TOKEN}",
      },
      compression: "none",
    });
    expect(JSON.stringify(config)).not.toContain("elastic-secret");
    expect(JSON.stringify(config)).not.toContain("sk-lf-test");
    expect(JSON.stringify(config)).not.toContain("custom-secret");
    expect(JSON.stringify(config)).not.toContain("elastic.example.com");
    expect(JSON.stringify(config)).not.toContain("langfuse.example.com");
    expect(JSON.stringify(config)).not.toContain("otel.example.com");
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
    ).toEqual(
      expect.arrayContaining([
        'set(span.attributes["langfuse.session.id"], span.attributes["session.id"]) where span.attributes["session.id"] != nil',
        'set(span.attributes["langfuse.observation.type"], "generation") where span.attributes["gen_ai.operation.name"] == "chat"',
        'set(span.attributes["langfuse.observation.type"], "span") where span.attributes["gen_ai.operation.name"] != "chat"',
        'set(span.attributes["langfuse.observation.metadata.eveland.operation_type"], span.attributes["gen_ai.operation.name"]) where span.attributes["gen_ai.operation.name"] != nil',
        'set(span.attributes["langfuse.release"], resource.attributes["eveland.release.id"]) where resource.attributes["eveland.release.id"] != nil',
        'set(span.attributes["langfuse.observation.model.name"], span.attributes["gen_ai.request.model"]) where span.attributes["gen_ai.request.model"] != nil',
        'set(span.attributes["langfuse.observation.input"], span.attributes["gen_ai.tool.call.arguments"]) where span.attributes["gen_ai.tool.call.arguments"] != nil',
        'set(span.attributes["langfuse.observation.output"], span.attributes["gen_ai.tool.call.result"]) where span.attributes["gen_ai.tool.call.result"] != nil',
        'set(span.attributes["langfuse.observation.input"], span.attributes["gen_ai.agent.input"]) where span.attributes["gen_ai.agent.input"] != nil',
        'set(span.attributes["langfuse.observation.output"], span.attributes["gen_ai.agent.output"]) where span.attributes["gen_ai.agent.output"] != nil',
        'set(span.attributes["langfuse.observation.cost_details"], Format("{\\"total\\":%v}", [span.attributes["eveland.gen_ai.usage.cost_usd"]])) where span.attributes["eveland.gen_ai.usage.cost_usd"] != nil',
      ]),
    );
    expect(
      config.service.pipelines[
        "traces/langfuse_destination_langfuse"
      ],
    ).toMatchObject({
      receivers: ["otlp/agent"],
      processors: [
      "memory_limiter",
      "resource/trusted_agent",
      "filter/trusted_agent",
      "filter/destination_langfuse",
      "transform/langfuse_destination_langfuse",
      "batch",
      ],
    });
    expect(
      config.exporters["otlp_http/destination_langfuse"],
    ).toMatchObject({ encoding: "json" });
    expect(config.processors).not.toHaveProperty(
      "resource/redact_agent_credential",
    );
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
      "logs/custom_destination_custom": {
        receivers: ["otlp/platform"],
      },
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

  test("keeps rendering when a destination cannot be decrypted or its kind disagrees", () => {
    const policy: ObservabilityPolicy = {
      ...createDefaultObservabilityPolicy(5),
      externalDestinations: [
        {
          id: "destination_sealed",
          kind: "custom_otlp",
          enabled: true,
          securityRevision: 1,
          // Sealed under a since-rotated APP_SECRET_KEY. The product keeps such a
          // destination listed so an Admin can replace its credentials.
          encryptedConfig: JSON.stringify(
            encryptSecretValue(
              JSON.stringify({ kind: "custom_otlp" }),
              "eveland-dev-secret-key-111111111",
            ),
          ),
          supportedSignals: ["logs"],
          domains: ["agent"],
          filterProfile: "custom",
        },
        {
          id: "destination_mismatched",
          kind: "elastic",
          enabled: true,
          securityRevision: 1,
          // Sealed payload claims a different kind than the plaintext record.
          encryptedConfig: encrypted({
            kind: "langfuse",
            baseUrl: "https://langfuse.example.com",
            publicKey: "pk-lf-test",
            secretKey: "sk-lf-test",
          }),
          supportedSignals: ["logs"],
          filterProfile: "all_eveland",
        } as unknown as ObservabilityPolicy["externalDestinations"][number],
        {
          id: "destination_healthy",
          kind: "custom_otlp",
          enabled: true,
          securityRevision: 1,
          encryptedConfig: encrypted({
            kind: "custom_otlp",
            endpoint: "https://collector.example.com:4318",
            supportedSignals: ["logs"],
            domains: ["agent"],
            headers: {},
          }),
          supportedSignals: ["logs"],
          domains: ["agent"],
          filterProfile: "custom",
        },
      ],
    };

    const config = parse(renderCollectorConfig({ policy, appSecretKey }));

    // The undecryptable destination still gets a pipeline: its exporter needs only
    // the id, and the persistent queue holds telemetry until the Admin repairs it.
    expect(config.exporters).toHaveProperty("otlp_http/destination_sealed");
    // A kind mismatch is skipped rather than fatal.
    expect(config.exporters).not.toHaveProperty(
      "otlp_http/destination_mismatched",
    );
    // Neither may block an unrelated healthy destination from being applied.
    expect(config.exporters).toHaveProperty("otlp_http/destination_healthy");
  });

});
