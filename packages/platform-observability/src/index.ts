import { context, metrics, trace, type Meter, type Tracer } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { logs, SeverityNumber, type AnyValue, type Logger } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import type { Instrumentation } from "@opentelemetry/instrumentation";
import { HostMetricsInstrumentation } from "@opentelemetry/instrumentation-host-metrics";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { RuntimeNodeInstrumentation } from "@opentelemetry/instrumentation-runtime-node";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { defaultResource, resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordExporter,
} from "@opentelemetry/sdk-logs";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";

const instrumentationName = "@evelandhq/platform-observability";
const developmentOtlpServiceToken = "eveland-dev-otlp-service-token";

type EmitLogInput = {
  severity: "debug" | "info" | "warn" | "error";
  eventName: string;
  body: AnyValue;
  attributes?: Record<string, string | number | boolean>;
};

export type PlatformObservability = {
  tracer: Tracer;
  logger: Logger;
  meter: Meter;
  emitLog(input: EmitLogInput): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
};

export type PlatformObservabilityInput = {
  serviceName: string;
  serviceVersion?: string;
  serviceInstanceId: string;
  environment: string;
  teamId: string;
  otlpEndpoint: string;
  otlpServiceToken: string;
  hostMetrics?: boolean;
  ignoredIncomingPaths?: string[];
  metricExportIntervalMs?: number;
  exporters?: {
    traces: SpanExporter;
    logs: LogRecordExporter;
    metrics: PushMetricExporter;
  };
  instrumentations?: Instrumentation[];
};

type EvelandResourceInput = Pick<
  PlatformObservabilityInput,
  "serviceName" | "serviceVersion" | "serviceInstanceId" | "environment" | "teamId"
>;

export type PrivateMetrics = {
  meter: Meter;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
};

export type PrivateMetricsInput = EvelandResourceInput & {
  telemetryDomain: "capacity";
  otlpEndpoint: string;
  otlpServiceToken: string;
  hostMetrics?: boolean;
  metricExportIntervalMs?: number;
  exporter?: PushMetricExporter;
};

export type PrivateLogs = {
  logger: Logger;
  emitLog(input: EmitLogInput): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
};

export type PrivateLogsInput = EvelandResourceInput & {
  telemetryDomain: "runtime";
  otlpEndpoint: string;
  otlpServiceToken: string;
  exporter?: LogRecordExporter;
};

export function resolveOtlpHttpSignalUrls(endpoint: string): {
  traces: string;
  logs: string;
  metrics: string;
} {
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Platform OTLP endpoint must use HTTP or HTTPS.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Platform OTLP endpoint must not contain credentials.");
  }
  const base = parsed.toString().replace(/\/+$/, "");
  return {
    traces: `${base}/v1/traces`,
    logs: `${base}/v1/logs`,
    metrics: `${base}/v1/metrics`,
  };
}

export function resolvePlatformOtlpServiceToken(env: Record<string, string | undefined>): string {
  const token = env.EVELAND_OTLP_SERVICE_TOKEN;
  if (token) return token;
  if (env.NODE_ENV === "production") {
    throw new Error("EVELAND_OTLP_SERVICE_TOKEN is required in production.");
  }
  return developmentOtlpServiceToken;
}

function otlpAuthorizationHeaders(serviceToken: string): Record<string, string> {
  if (!serviceToken) {
    throw new Error("EVELAND_OTLP_SERVICE_TOKEN must not be empty.");
  }
  return { authorization: `Bearer ${serviceToken}` };
}

export function runWithPlatformTracingSuppressed<T>(callback: () => T): T {
  return context.with(suppressTracing(context.active()), callback);
}

export function createPlatformResource(input: EvelandResourceInput): Resource {
  return createEvelandResource(input, "platform");
}

function createEvelandResource(
  input: EvelandResourceInput,
  telemetryDomain: "platform" | "runtime" | "capacity",
): Resource {
  return defaultResource().merge(
    resourceFromAttributes({
      "service.name": input.serviceName,
      ...(input.serviceVersion ? { "service.version": input.serviceVersion } : {}),
      "service.instance.id": input.serviceInstanceId,
      "deployment.environment.name": input.environment,
      "eveland.team.id": input.teamId,
      "eveland.telemetry.domain": telemetryDomain,
    }),
  );
}

export function startPlatformObservability(
  input: PlatformObservabilityInput,
): PlatformObservability {
  const urls = resolveOtlpHttpSignalUrls(input.otlpEndpoint);
  const headers = otlpAuthorizationHeaders(input.otlpServiceToken);
  const traceExporter =
    input.exporters?.traces ?? new OTLPTraceExporter({ url: urls.traces, headers });
  const logExporter = input.exporters?.logs ?? new OTLPLogExporter({ url: urls.logs, headers });
  const metricExporter =
    input.exporters?.metrics ?? new OTLPMetricExporter({ url: urls.metrics, headers });
  const spanProcessor = new BatchSpanProcessor(traceExporter);
  const logProcessor = new BatchLogRecordProcessor({
    exporter: logExporter,
  });
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: input.metricExportIntervalMs ?? 60_000,
  });
  const sdk = new NodeSDK({
    resource: createPlatformResource(input),
    spanProcessors: [spanProcessor],
    logRecordProcessors: [logProcessor],
    metricReaders: [metricReader],
    instrumentations: input.instrumentations ?? createDefaultInstrumentations(input),
  });
  sdk.start();
  const tracer = trace.getTracer(instrumentationName);
  const logger = logs.getLogger(instrumentationName);
  const meter = metrics.getMeter(instrumentationName);

  return {
    tracer,
    logger,
    meter,
    emitLog: (log) => emitLog(logger, log),
    forceFlush: async () => {
      await Promise.all([
        spanProcessor.forceFlush(),
        logProcessor.forceFlush(),
        metricReader.forceFlush(),
      ]);
    },
    shutdown: () => sdk.shutdown(),
  };
}

export function startPrivateLogs(input: PrivateLogsInput): PrivateLogs {
  const urls = resolveOtlpHttpSignalUrls(input.otlpEndpoint);
  const exporter =
    input.exporter ??
    new OTLPLogExporter({
      url: urls.logs,
      headers: otlpAuthorizationHeaders(input.otlpServiceToken),
    });
  const processor = new BatchLogRecordProcessor({ exporter });
  const provider = new LoggerProvider({
    resource: createEvelandResource(input, input.telemetryDomain),
    processors: [processor],
  });
  const logger = provider.getLogger(instrumentationName);

  return {
    logger,
    emitLog: (log) => emitLog(logger, log),
    forceFlush: () => processor.forceFlush(),
    shutdown: () => provider.shutdown(),
  };
}

export function startPrivateMetrics(input: PrivateMetricsInput): PrivateMetrics {
  const urls = resolveOtlpHttpSignalUrls(input.otlpEndpoint);
  const exporter =
    input.exporter ??
    new OTLPMetricExporter({
      url: urls.metrics,
      headers: otlpAuthorizationHeaders(input.otlpServiceToken),
    });
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: input.metricExportIntervalMs ?? 60_000,
  });
  const provider = new MeterProvider({
    resource: createEvelandResource(input, input.telemetryDomain),
    readers: [reader],
  });
  const instrumentations = input.hostMetrics ? [new HostMetricsInstrumentation()] : [];
  for (const instrumentation of instrumentations) {
    instrumentation.setMeterProvider(provider);
    instrumentation.enable();
  }

  return {
    meter: provider.getMeter(instrumentationName),
    forceFlush: () => reader.forceFlush(),
    shutdown: async () => {
      for (const instrumentation of instrumentations) {
        instrumentation.disable();
      }
      await provider.shutdown();
    },
  };
}

function emitLog(logger: Logger, log: EmitLogInput): void {
  const severityNumber = {
    debug: SeverityNumber.DEBUG,
    info: SeverityNumber.INFO,
    warn: SeverityNumber.WARN,
    error: SeverityNumber.ERROR,
  }[log.severity];
  logger.emit({
    severityNumber,
    severityText: log.severity.toUpperCase(),
    eventName: log.eventName,
    body: log.body,
    attributes: log.attributes,
  });
}

function createDefaultInstrumentations(input: PlatformObservabilityInput): Instrumentation[] {
  return [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (request) =>
        input.ignoredIncomingPaths?.some((prefix) => (request.url ?? "").startsWith(prefix)) ??
        false,
    }),
    new UndiciInstrumentation(),
    new PgInstrumentation(),
    new RuntimeNodeInstrumentation(),
    ...(input.hostMetrics ? [new HostMetricsInstrumentation()] : []),
  ];
}
