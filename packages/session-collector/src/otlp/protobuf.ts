import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ObservabilitySignal } from "@eveland/core/observability";
import protobufjs from "protobufjs";
import type { Type } from "protobufjs";

const { Root } = protobufjs;

const protoRootDirectory = fileURLToPath(
  new URL("../../proto/", import.meta.url),
);
const protoRoot = new Root();
protoRoot.resolvePath = (_origin, target) =>
  resolve(protoRootDirectory, target);
protoRoot.loadSync([
  resolve(
    protoRootDirectory,
    "opentelemetry/proto/collector/trace/v1/trace_service.proto",
  ),
  resolve(
    protoRootDirectory,
    "opentelemetry/proto/collector/logs/v1/logs_service.proto",
  ),
  resolve(
    protoRootDirectory,
    "opentelemetry/proto/collector/metrics/v1/metrics_service.proto",
  ),
]);

const requestTypes = {
  traces: lookupType(
    "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
  ),
  logs: lookupType(
    "opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest",
  ),
  metrics: lookupType(
    "opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest",
  ),
} satisfies Record<ObservabilitySignal, Type>;

const responseTypes = {
  traces: lookupType(
    "opentelemetry.proto.collector.trace.v1.ExportTraceServiceResponse",
  ),
  logs: lookupType(
    "opentelemetry.proto.collector.logs.v1.ExportLogsServiceResponse",
  ),
  metrics: lookupType(
    "opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceResponse",
  ),
} satisfies Record<ObservabilitySignal, Type>;

export function decodeOtlpProtobufRequest(
  signal: ObservabilitySignal,
  bytes: Uint8Array,
): Record<string, unknown> | null {
  try {
    const type = requestTypes[signal];
    const message = type.decode(bytes);
    const payload = type.toObject(message, {
      arrays: true,
      objects: true,
      longs: String,
      bytes: String,
    }) as Record<string, unknown>;
    normalizeOtlpIdentifiers(signal, payload);
    return payload;
  } catch {
    return null;
  }
}

export function encodeOtlpProtobufResponse(
  signal: ObservabilitySignal,
  response: Record<string, unknown>,
): Uint8Array {
  const type = responseTypes[signal];
  return type.encode(type.fromObject(response)).finish();
}

function normalizeOtlpIdentifiers(
  signal: ObservabilitySignal,
  payload: Record<string, unknown>,
): void {
  if (signal === "traces") {
    for (const resourceSpans of records(payload.resourceSpans)) {
      for (const scopeSpans of records(resourceSpans.scopeSpans)) {
        for (const span of records(scopeSpans.spans)) {
          normalizeTraceContext(span);
          for (const link of records(span.links)) {
            normalizeTraceContext(link);
          }
        }
      }
    }
    return;
  }
  if (signal === "logs") {
    for (const resourceLogs of records(payload.resourceLogs)) {
      for (const scopeLogs of records(resourceLogs.scopeLogs)) {
        for (const logRecord of records(scopeLogs.logRecords)) {
          normalizeTraceContext(logRecord);
        }
      }
    }
    return;
  }
  for (const resourceMetrics of records(payload.resourceMetrics)) {
    for (const scopeMetrics of records(resourceMetrics.scopeMetrics)) {
      for (const metric of records(scopeMetrics.metrics)) {
        for (const dataField of [
          "gauge",
          "sum",
          "histogram",
          "exponentialHistogram",
          "summary",
        ]) {
          const data = record(metric[dataField]);
          for (const point of records(data?.dataPoints)) {
            for (const exemplar of records(point.exemplars)) {
              normalizeTraceContext(exemplar);
            }
          }
        }
      }
    }
  }
}

function normalizeTraceContext(value: Record<string, unknown>): void {
  normalizeIdentifier(value, "traceId", 16);
  normalizeIdentifier(value, "spanId", 8);
  normalizeIdentifier(value, "parentSpanId", 8);
}

function normalizeIdentifier(
  value: Record<string, unknown>,
  field: string,
  expectedBytes: number,
): void {
  const encoded = value[field];
  if (typeof encoded !== "string" || encoded.length === 0) return;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength !== expectedBytes) return;
  value[field] = bytes.toString("hex");
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const child = record(item);
        return child ? [child] : [];
      })
    : [];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function lookupType(name: string): Type {
  return protoRoot.lookupType(name);
}
