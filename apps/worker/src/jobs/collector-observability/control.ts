import { execa } from "execa";
import { API_INTERNAL_URL_FALLBACK } from "@evelandhq/core/ports";

const DEFAULT_COLLECTOR_IMAGE = "otel/opentelemetry-collector-contrib:0.149.0";
const DEFAULT_COLLECTOR_CONTAINER = "eveland-otel-collector";

export type CollectorConfigLocation = {
  workerPath: string;
  hostPath: string;
};

export async function validateCollectorConfig(
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
      `EVELAND_BUILTIN_OTLP_ENDPOINT=${API_INTERNAL_URL_FALLBACK}/internal/otel`,
      "--env",
      `EVELAND_EXTERNAL_OTLP_PROXY_ENDPOINT=${API_INTERNAL_URL_FALLBACK}/internal/observability/destinations`,
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

export async function restartCollectorContainer(env: NodeJS.ProcessEnv): Promise<void> {
  const container = env.EVELAND_OTEL_COLLECTOR_CONTAINER ?? DEFAULT_COLLECTOR_CONTAINER;
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
