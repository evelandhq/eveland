import {
  COLLECTOR_SELF_SERVICE_NAME,
  collectorExporterComponentId,
  externalDestinationConfigSchema,
  OBSERVABILITY_SIGNALS,
  TELEMETRY_DOMAINS,
  type ExternalDestinationConfig,
  type ObservabilityPolicy,
  type ObservabilitySignal,
  type TelemetryDomain,
} from "@eveland/core/observability";
import {
  decryptSecretValue,
  type EncryptedSecret,
} from "@eveland/core/server/secrets";
import { DEFAULT_TEAM_ID, type Store } from "@eveland/db";
import { execa } from "execa";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";

const DEFAULT_COLLECTOR_IMAGE =
  "otel/opentelemetry-collector-contrib:0.149.0";
const DEFAULT_COLLECTOR_CONTAINER = "eveland-otel-collector";
const devSecretKey = "eveland-dev-secret-key-000000000";

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

type CollectorConfigLocation = {
  workerPath: string;
  hostPath: string;
};

export function createCollectorObservabilityReconciler(input: {
  store: Store;
  env: NodeJS.ProcessEnv;
  validateConfig?: (location: CollectorConfigLocation) => Promise<void>;
  restartCollector?: () => Promise<void>;
}): () => Promise<number> {
  let appliedRevision: number | undefined;
  let inFlight: Promise<number> | undefined;
  const validateConfig =
    input.validateConfig ??
    ((location) => validateCollectorConfig(location, input.env));
  const restartCollector =
    input.restartCollector ?? (() => restartCollectorContainer(input.env));

  const reconcile = async (): Promise<number> => {
    const policy = await input.store.getObservabilityPolicy(DEFAULT_TEAM_ID);
    if (policy.revision === appliedRevision) return 0;

    const config = renderCollectorConfig({
      policy,
      appSecretKey: input.env.APP_SECRET_KEY ?? devSecretKey,
    });
    const configDirectory = path.resolve(
      input.env.EVELAND_DATA_DIR ?? ".eveland-data",
      "otel",
    );
    const hostConfigDirectory = path.resolve(
      input.env.EVELAND_HOST_DATA_DIR ??
        input.env.EVELAND_DATA_DIR ??
        ".eveland-data",
      "otel",
    );
    const finalPath = path.join(configDirectory, "collector.yaml");
    const candidate = {
      workerPath: path.join(configDirectory, "collector.yaml.candidate"),
      hostPath: path.join(hostConfigDirectory, "collector.yaml.candidate"),
    };
    const previous = await readFile(finalPath, "utf8").catch(() => null);
    if (previous === config) {
      appliedRevision = policy.revision;
      return 0;
    }

    await mkdir(configDirectory, { recursive: true, mode: 0o700 });
    await rm(candidate.workerPath, { force: true });
    await writeFile(candidate.workerPath, config, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      await validateConfig(candidate);
      await rename(candidate.workerPath, finalPath);
      try {
        await restartCollector();
      } catch (error) {
        if (previous === null) {
          await rm(finalPath, { force: true });
        } else {
          const rollbackPath = `${finalPath}.rollback`;
          await writeFile(rollbackPath, previous, {
            encoding: "utf8",
            mode: 0o600,
          });
          await rename(rollbackPath, finalPath);
          await restartCollector().catch(() => undefined);
        }
        throw error;
      }
    } finally {
      await rm(candidate.workerPath, { force: true });
    }

    appliedRevision = policy.revision;
    return 1;
  };

  return () => {
    if (inFlight) return inFlight;
    inFlight = reconcile().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}

export function renderCollectorConfig(input: {
  policy: ObservabilityPolicy;
  appSecretKey: string;
}): string {
  const config = baseCollectorConfig();

  for (const destination of input.policy.externalDestinations) {
    if (!destination.enabled) continue;
    const destinationConfig = decryptDestinationConfig(
      destination.encryptedConfig,
      input.appSecretKey,
    );
    if (destinationConfig.kind !== destination.kind) {
      throw new Error(
        `Observability destination ${destination.id} has an invalid encrypted configuration.`,
      );
    }

    const exporterId = collectorExporterComponentId(destination.id);
    const componentId = exporterId.slice(exporterId.indexOf("/") + 1);
    config.exporters[exporterId] = externalExporter(destinationConfig);

    const domains =
      destination.kind === "langfuse"
        ? (["agent"] satisfies TelemetryDomain[])
        : destination.kind === "custom_otlp"
          ? destination.domains
          : [...TELEMETRY_DOMAINS];
    const filterId = `filter/${componentId}`;
    config.processors[filterId] = domainFilter(
      domains,
      destination.supportedSignals,
    );
    const transformId =
      destination.kind === "langfuse"
        ? `transform/langfuse_${componentId}`
        : null;
    if (transformId) {
      config.processors[transformId] = langfuseTransform();
    }

    for (const signal of destination.supportedSignals) {
      config.service.pipelines[
        `${signal}/${destination.kind.replace("_otlp", "")}_${componentId}`
      ] = {
        receivers: ["otlp"],
        processors: [
          "memory_limiter",
          filterId,
          ...(transformId ? [transformId] : []),
          "batch",
        ],
        exporters: [exporterId],
      };
      if (signal === "metrics" && domains.includes("platform")) {
        config.service.pipelines[
          `metrics/collector_self_${destination.kind.replace("_otlp", "")}_${componentId}`
        ] = {
          receivers: ["prometheus/collector_self"],
          processors: [
            "memory_limiter",
            "resource/collector_self",
            "batch",
          ],
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
      file_storage: {
        directory: "/var/lib/otelcol/storage",
        create_directory: true,
      },
      health_check: {
        endpoint: "0.0.0.0:13133",
      },
    },
    receivers: {
      otlp: {
        protocols: {
          grpc: { endpoint: "0.0.0.0:4317" },
          http: { endpoint: "0.0.0.0:4318" },
        },
      },
      "prometheus/collector_self": {
        config: {
          scrape_configs: [
            {
              job_name: "eveland-otel-collector",
              scrape_interval: "15s",
              static_configs: [
                { targets: ["127.0.0.1:8888"] },
              ],
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
      "filter/builtin_eveland": domainFilter(
        [...TELEMETRY_DOMAINS],
        [...OBSERVABILITY_SIGNALS],
      ),
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
      extensions: ["file_storage", "health_check"],
      pipelines: {
        ...Object.fromEntries(
          OBSERVABILITY_SIGNALS.map((signal) => [
            signal,
            {
              receivers: ["otlp"],
              processors: [
                "memory_limiter",
                "filter/builtin_eveland",
                "batch",
              ],
              exporters: ["otlp_http/builtin"],
            },
          ]),
        ),
        "metrics/collector_self": {
          receivers: ["prometheus/collector_self"],
          processors: [
            "memory_limiter",
            "resource/collector_self",
            "batch",
          ],
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
      },
    },
  };
}

export function decryptDestinationConfig(
  encryptedConfig: string,
  appSecretKey: string,
): ExternalDestinationConfig {
  try {
    const encrypted = JSON.parse(encryptedConfig) as EncryptedSecret;
    return externalDestinationConfigSchema.parse(
      JSON.parse(decryptSecretValue(encrypted, appSecretKey)),
    );
  } catch {
    throw new Error("Could not decrypt an observability destination.");
  }
}

function externalExporter(config: ExternalDestinationConfig) {
  switch (config.kind) {
    case "elastic":
      return {
        endpoint: config.endpoint,
        headers: {
          authorization: `${
            config.authorization.type === "api_key" ? "ApiKey" : "Bearer"
          } ${config.authorization.value}`,
        },
        ...reliableExporterDelivery(),
      };
    case "langfuse":
      return {
        traces_endpoint: config.tracesEndpoint,
        headers: {
          authorization: `Basic ${Buffer.from(
            `${config.publicKey}:${config.secretKey}`,
          ).toString("base64")}`,
          "x-langfuse-ingestion-version": "4",
        },
        ...reliableExporterDelivery(),
      };
    case "custom_otlp":
      return {
        endpoint: config.endpoint,
        headers: config.headers,
        ...reliableExporterDelivery(),
      };
  }
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

function domainFilter(
  domains: TelemetryDomain[],
  signals: ObservabilitySignal[],
) {
  const dropCondition = domains
    .map(
      (domain) =>
        `resource.attributes["eveland.telemetry.domain"] != "${domain}"`,
    )
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
    ...Object.fromEntries(
      signals.map((signal) => [conditionKeys[signal], [dropCondition]]),
    ),
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

async function validateCollectorConfig(
  location: CollectorConfigLocation,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const image = env.EVELAND_OTEL_COLLECTOR_IMAGE ?? DEFAULT_COLLECTOR_IMAGE;
  const result = await execa(
    "docker",
    [
      "run",
      "--rm",
      "--user",
      "0:0",
      "--volume",
      `${location.hostPath}:/etc/eveland-otel/collector.yaml:ro`,
      "--env",
      "EVELAND_BUILTIN_OTLP_ENDPOINT=http://127.0.0.1:4000/internal/otel",
      "--env",
      "EVELAND_OTLP_SERVICE_TOKEN=validation-only",
      image,
      "validate",
      "--config=/etc/eveland-otel/collector.yaml",
    ],
    { all: true, reject: false },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `OpenTelemetry Collector rejected the generated configuration: ${
        result.all?.trim() || "validation failed"
      }`,
    );
  }
}

async function restartCollectorContainer(
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const container =
    env.EVELAND_OTEL_COLLECTOR_CONTAINER ?? DEFAULT_COLLECTOR_CONTAINER;
  const result = await execa("docker", ["restart", container], {
    all: true,
    reject: false,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not restart the OpenTelemetry Collector container "${container}": ${
        result.all?.trim() || "docker restart failed"
      }`,
    );
  }
}
