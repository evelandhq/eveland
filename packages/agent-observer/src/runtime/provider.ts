import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from "@opentelemetry/sdk-logs";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import type {
  PrivateAgentTelemetryExporters,
  RuntimeAgentPolicy,
} from "./contracts.js";

const instrumentationScope = "@eveland/eve-runtime";

export function createAgentTelemetryProviders(input: {
  policy: RuntimeAgentPolicy;
  exporters?: PrivateAgentTelemetryExporters;
  runtimeInstanceId?: string;
}) {
  const runtimeInstanceId =
    input.runtimeInstanceId ?? process.env.EVELAND_RUNTIME_INSTANCE_ID;
  const endpoint = input.policy.otlp.endpoint.replace(/\/+$/, "");
  const exporters = input.exporters ?? {
    traces: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    logs: new OTLPLogExporter({ url: `${endpoint}/v1/logs` }),
    metrics: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
  };
  const resource = resourceFromAttributes({
    "service.name": "eveland-agent",
    "service.instance.id": input.policy.resource.deploymentId,
    "deployment.environment.name": input.policy.resource.environment,
    "process.runtime.name": "nodejs",
    "eveland.team.id": input.policy.resource.teamId,
    "eveland.project.id": input.policy.resource.projectId,
    "eveland.release.id": input.policy.resource.releaseId,
    "eveland.deployment.id": input.policy.resource.deploymentId,
    "eveland.runtime.kind": input.policy.resource.runtimeKind,
    "eveland.telemetry.domain": "agent",
    "eveland.deployment.credential": input.policy.deploymentCredential,
    ...(runtimeInstanceId
      ? { "eveland.runtime.instance.id": runtimeInstanceId }
      : {}),
  });
  const tracerProvider = new BasicTracerProvider({
    resource,
    sampler: new TraceIdRatioBasedSampler(input.policy.capture.sampleRatio),
    spanProcessors: [new BatchSpanProcessor(exporters.traces)],
  });
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor({
        exporter: exporters.logs,
      }),
    ],
  });
  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: exporters.metrics,
      }),
    ],
  });

  return {
    tracer: tracerProvider.getTracer(instrumentationScope),
    logger: loggerProvider.getLogger(instrumentationScope),
    meter: meterProvider.getMeter(instrumentationScope),
    async forceFlush(): Promise<void> {
      await Promise.all([
        tracerProvider.forceFlush(),
        loggerProvider.forceFlush(),
        meterProvider.forceFlush(),
      ]);
    },
    async shutdown(): Promise<void> {
      await Promise.all([
        tracerProvider.shutdown(),
        loggerProvider.shutdown(),
        meterProvider.shutdown(),
      ]);
    },
  };
}

export type AgentTelemetryProviders = ReturnType<
  typeof createAgentTelemetryProviders
>;
