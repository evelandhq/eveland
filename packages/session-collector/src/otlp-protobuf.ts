import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ObservabilitySignal } from "@eveland/core/observability";
import { Root, type Type } from "protobufjs";

const protoRootDirectory = fileURLToPath(
  new URL("../proto/", import.meta.url),
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
    return type.toObject(message, {
      arrays: true,
      objects: true,
      longs: String,
      bytes: String,
    }) as Record<string, unknown>;
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

function lookupType(name: string): Type {
  return protoRoot.lookupType(name);
}
