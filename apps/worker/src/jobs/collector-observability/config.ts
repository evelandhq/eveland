import {
  COLLECTOR_SELF_SERVICE_NAME,
  collectorExporterComponentId,
  externalDestinationDomains,
  type ExternalDestinationConfig,
  type ObservabilityPolicy,
  type ObservabilitySignal,
  type TelemetryDomain,
} from "@eveland/core/observability";
import { decryptDestinationConfig } from "@eveland/core/server/observability";
import { DEFAULT_TEAM_ID } from "@eveland/db";
import { stringify } from "yaml";

const builtInCapacityMetricNames = [
  "eveland.worker.heartbeat",
  "eveland.worker.tick.duration",
  "system.cpu.utilization",
  "system.memory.usage",
  "system.filesystem.usage",
  "system.filesystem.limit",
  "eveland.system.filesystem.inodes.usage",
  "eveland.system.filesystem.inodes.limit",
  "eveland.host.load.1m",
  "eveland.host.cpu.logical.count",
  "eveland.postgres.connections.usage",
  "eveland.postgres.connections.limit",
  "eveland.postgres.agent_pool_size",
] as const;

type CollectorConfig = {
  extensions: Record<string, unknown>;
  receivers: Record<string, unknown>;
  processors: Record<string, unknown>;
  exporters: Record<string, unknown>;
  service: {
    extensions: string[];
    pipelines: Record<string, unknown>;
    telemetry: Record<string, unknown>;
  };
};

export function renderCollectorConfig(input: {
  policy: ObservabilityPolicy;
  appSecretKey: string;
}): string {
  const config = baseCollectorConfig();

  for (const destination of input.policy.externalDestinations) {
    if (!destination.enabled) continue;
    // A destination sealed under a rotated APP_SECRET_KEY stays listed so an Admin
    // can replace its credentials, so it must not abort the whole reconciliation
    // and freeze every other pipeline revision. Its exporter needs only the id and
    // kind; the API egress proxy holds the decrypted config and answers 502 until
    // the Admin repairs it, while the persistent queue keeps the telemetry.
    let destinationConfig: ExternalDestinationConfig | undefined;
    try {
      destinationConfig = decryptDestinationConfig(destination.encryptedConfig, input.appSecretKey);
    } catch {
      destinationConfig = undefined;
    }
    // Skip rather than throw for the same reason: one corrupt destination must
    // not freeze the revision for every other pipeline. The API egress proxy
    // repeats this check and refuses to forward, so nothing is delivered under a
    // mismatched kind.
    if (destinationConfig && destinationConfig.kind !== destination.kind) {
      continue;
    }

    const exporterId = collectorExporterComponentId(destination.id);
    const componentId = exporterId.slice(exporterId.indexOf("/") + 1);
    config.exporters[exporterId] = externalExporter(destination.id, destination.kind);

    const domains = externalDestinationDomains(destination);
    const filterId = `filter/${componentId}`;
    config.processors[filterId] = domainFilter(domains, destination.supportedSignals);
    const transformId =
      destination.kind === "langfuse" ? `transform/langfuse_${componentId}` : null;
    if (transformId) {
      config.processors[transformId] = langfuseTransform();
    }

    for (const signal of destination.supportedSignals) {
      const pipelineName = `${signal}/${destination.kind.replace("_otlp", "")}_${componentId}`;
      const agentProcessors = [
        "memory_limiter",
        "resource/trusted_agent",
        "filter/trusted_agent",
        filterId,
        ...(transformId ? [transformId] : []),
        "batch",
      ];
      const platformProcessors = [
        "memory_limiter",
        filterId,
        ...(transformId ? [transformId] : []),
        "batch",
      ];
      const includesAgent = domains.includes("agent");
      const includesPlatform = domains.some((domain) => domain !== "agent");
      if (includesAgent && !includesPlatform) {
        config.service.pipelines[pipelineName] = {
          receivers: ["otlp/agent"],
          processors: agentProcessors,
          exporters: [exporterId],
        };
      } else {
        config.service.pipelines[pipelineName] = {
          receivers: ["otlp/platform"],
          processors: platformProcessors,
          exporters: [exporterId],
        };
        if (includesAgent) {
          config.service.pipelines[`${signal}/agent_${componentId}`] = {
            receivers: ["otlp/agent"],
            processors: agentProcessors,
            exporters: [exporterId],
          };
        }
      }
      if (signal === "metrics" && domains.includes("platform")) {
        config.service.pipelines[
          `metrics/collector_self_${destination.kind.replace("_otlp", "")}_${componentId}`
        ] = {
          receivers: ["prometheus/collector_self"],
          processors: ["memory_limiter", "resource/collector_self", "batch"],
          exporters: [exporterId],
        };
      }
    }
  }

  return stringify(config, {
    lineWidth: 0,
    singleQuote: false,
  });
}

function baseCollectorConfig(): CollectorConfig {
  return {
    extensions: {
      "bearertokenauth/platform": {
        token: "${env:EVELAND_OTLP_SERVICE_TOKEN}",
      },
      file_storage: {
        directory: "/var/lib/otelcol/storage",
        create_directory: true,
      },
      health_check: {
        endpoint: "0.0.0.0:13133",
      },
    },
    receivers: {
      "otlp/platform": {
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
      },
      "otlp/agent": {
        protocols: {
          grpc: { endpoint: "0.0.0.0:4327" },
          http: { endpoint: "0.0.0.0:4328" },
        },
      },
      "prometheus/collector_self": {
        config: {
          scrape_configs: [
            {
              job_name: "eveland-otel-collector",
              scrape_interval: "15s",
              static_configs: [{ targets: ["127.0.0.1:8888"] }],
            },
          ],
        },
      },
    },
    processors: {
      memory_limiter: {
        check_interval: "1s",
        limit_mib: 256,
        spike_limit_mib: 64,
      },
      batch: {
        timeout: "1s",
        send_batch_size: 1024,
      },
      "resource/trusted_agent": {
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
      },
      "filter/trusted_agent": {
        error_mode: "ignore",
        trace_conditions: ['scope.name != "@eveland/eve-runtime"'],
        log_conditions: ['scope.name != "@eveland/eve-runtime"'],
        metric_conditions: ['scope.name != "@eveland/eve-runtime"'],
      },
      "filter/builtin_capacity": {
        error_mode: "ignore",
        metric_conditions: [
          'resource.attributes["service.name"] != "eveland-worker" or resource.attributes["eveland.telemetry.domain"] != "capacity"',
          builtInCapacityMetricNames.map((name) => `metric.name != "${name}"`).join(" and "),
          'metric.name == "system.cpu.utilization" and datapoint.attributes["cpu.mode"] == "idle"',
          'metric.name == "system.memory.usage" and datapoint.attributes["system.memory.state"] != "used" and datapoint.attributes["system.memory.state"] != "free"',
          'metric.name == "system.filesystem.usage" and datapoint.attributes["system.filesystem.state"] != "free"',
          'metric.name == "eveland.system.filesystem.inodes.usage" and datapoint.attributes["eveland.system.filesystem.inodes.state"] != "free"',
        ],
      },
      "resource/collector_self": {
        attributes: [
          {
            key: "service.name",
            value: COLLECTOR_SELF_SERVICE_NAME,
            action: "upsert",
          },
          {
            key: "service.instance.id",
            value: "${env:HOSTNAME}",
            action: "upsert",
          },
          {
            key: "eveland.team.id",
            value: DEFAULT_TEAM_ID,
            action: "upsert",
          },
          {
            key: "eveland.telemetry.domain",
            value: "platform",
            action: "upsert",
          },
        ],
      },
    },
    exporters: {
      "otlp_http/builtin": {
        endpoint: "${env:EVELAND_BUILTIN_OTLP_ENDPOINT}",
        compression: "none",
        headers: {
          authorization: "Bearer ${env:EVELAND_OTLP_SERVICE_TOKEN}",
        },
        ...reliableExporterDelivery(),
      },
    },
    service: {
      extensions: ["bearertokenauth/platform", "file_storage", "health_check"],
      pipelines: {
        // Traces are deliberately absent: Built-in keeps no span read model, so
        // forwarding them would cost a full parse per batch for nothing. Spans reach
        // external destinations through their own pipelines below.
        logs: {
          receivers: ["otlp/agent"],
          processors: ["memory_limiter", "resource/trusted_agent", "filter/trusted_agent", "batch"],
          exporters: ["otlp_http/builtin"],
        },
        metrics: {
          receivers: ["otlp/platform"],
          processors: ["memory_limiter", "filter/builtin_capacity", "batch"],
          exporters: ["otlp_http/builtin"],
        },
      },
      telemetry: {
        resource: {
          "service.name": COLLECTOR_SELF_SERVICE_NAME,
          "service.instance.id": "${env:HOSTNAME}",
          "eveland.team.id": DEFAULT_TEAM_ID,
          "eveland.telemetry.domain": "platform",
        },
        metrics: {
          // `detailed` adds per-component internal metrics nothing reads. Built-in
          // keeps only exporter delivery and queue series, so the extra cardinality
          // is pure write amplification.
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
      },
    },
  };
}

function externalExporter(destinationId: string, kind: "elastic" | "langfuse" | "custom_otlp") {
  const endpoint = "${env:EVELAND_EXTERNAL_OTLP_PROXY_ENDPOINT}/" + destinationId;
  return {
    ...(kind === "langfuse" ? { traces_endpoint: `${endpoint}/v1/traces` } : { endpoint }),
    encoding: "json",
    compression: "none",
    headers: {
      authorization: "Bearer ${env:EVELAND_OTLP_SERVICE_TOKEN}",
    },
    ...reliableExporterDelivery(),
  };
}

function reliableExporterDelivery() {
  return {
    retry_on_failure: {
      enabled: true,
      initial_interval: "1s",
      max_interval: "30s",
      max_elapsed_time: "0s",
    },
    sending_queue: {
      enabled: true,
      storage: "file_storage",
      queue_size: 10000,
    },
  };
}

function domainFilter(domains: readonly TelemetryDomain[], signals: ObservabilitySignal[]) {
  const dropCondition = domains
    .map((domain) => `resource.attributes["eveland.telemetry.domain"] != "${domain}"`)
    .join(" and ");
  const conditionKeys: Record<
    ObservabilitySignal,
    "trace_conditions" | "log_conditions" | "metric_conditions"
  > = {
    traces: "trace_conditions",
    logs: "log_conditions",
    metrics: "metric_conditions",
  };
  return {
    error_mode: "ignore",
    ...Object.fromEntries(signals.map((signal) => [conditionKeys[signal], [dropCondition]])),
  };
}

function langfuseTransform() {
  return {
    error_mode: "ignore",
    trace_statements: [
      {
        context: "span",
        statements: [
          'set(span.attributes["langfuse.session.id"], span.attributes["session.id"]) where span.attributes["session.id"] != nil',
          'set(span.attributes["langfuse.trace.name"], span.attributes["gen_ai.agent.name"]) where span.attributes["gen_ai.agent.name"] != nil',
          'set(span.attributes["langfuse.release"], resource.attributes["service.version"]) where resource.attributes["service.version"] != nil',
          'set(span.attributes["langfuse.release"], resource.attributes["eveland.release.id"]) where resource.attributes["eveland.release.id"] != nil',
          'set(span.attributes["langfuse.environment"], resource.attributes["deployment.environment.name"]) where resource.attributes["deployment.environment.name"] != nil',
          'set(span.attributes["langfuse.observation.metadata.eveland.project_id"], resource.attributes["eveland.project.id"]) where resource.attributes["eveland.project.id"] != nil',
          'set(span.attributes["langfuse.observation.metadata.eveland.release_id"], resource.attributes["eveland.release.id"]) where resource.attributes["eveland.release.id"] != nil',
          'set(span.attributes["langfuse.observation.metadata.eveland.deployment_id"], resource.attributes["eveland.deployment.id"]) where resource.attributes["eveland.deployment.id"] != nil',
          'set(span.attributes["langfuse.observation.metadata.eveland.operation_type"], span.attributes["gen_ai.operation.name"]) where span.attributes["gen_ai.operation.name"] != nil',
          'set(span.attributes["langfuse.observation.type"], "generation") where span.attributes["gen_ai.operation.name"] == "chat"',
          'set(span.attributes["langfuse.observation.type"], "span") where span.attributes["gen_ai.operation.name"] != "chat"',
          'set(span.attributes["langfuse.observation.model.name"], span.attributes["gen_ai.request.model"]) where span.attributes["gen_ai.request.model"] != nil',
          'set(span.attributes["langfuse.observation.input"], span.attributes["gen_ai.input.messages"]) where span.attributes["gen_ai.input.messages"] != nil',
          'set(span.attributes["langfuse.observation.output"], span.attributes["gen_ai.output.messages"]) where span.attributes["gen_ai.output.messages"] != nil',
          'set(span.attributes["langfuse.observation.input"], span.attributes["gen_ai.tool.call.arguments"]) where span.attributes["gen_ai.tool.call.arguments"] != nil',
          'set(span.attributes["langfuse.observation.output"], span.attributes["gen_ai.tool.call.result"]) where span.attributes["gen_ai.tool.call.result"] != nil',
          'set(span.attributes["langfuse.observation.input"], span.attributes["gen_ai.agent.input"]) where span.attributes["gen_ai.agent.input"] != nil',
          'set(span.attributes["langfuse.observation.output"], span.attributes["gen_ai.agent.output"]) where span.attributes["gen_ai.agent.output"] != nil',
          'set(span.attributes["langfuse.observation.cost_details"], Format("{\\"total\\":%v}", [span.attributes["eveland.gen_ai.usage.cost_usd"]])) where span.attributes["eveland.gen_ai.usage.cost_usd"] != nil',
        ],
      },
    ],
  };
}
