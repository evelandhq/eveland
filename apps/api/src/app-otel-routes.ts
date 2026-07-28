import {
  UnmanagedTelemetryResourceError,
  type ObservabilitySignal,
} from "@eveland/core/observability";
import {
  deriveAgentTelemetrySecret,
  verifyAgentTelemetryCredential,
} from "@eveland/core/server/agent-telemetry-credential";
import type { Store } from "@eveland/db";
import {
  countOtlpSignalItems,
  createOtlpPartialSuccessResponse,
  decodeOtlpProtobufRequest,
  encodeOtlpProtobufResponse,
  projectAgentEventItemsFromOtlpLogs,
  projectInstanceTelemetryFromOtlpMetrics,
  projectOtlpSpans,
} from "@eveland/session-collector";
import { runWithPlatformTracingSuppressed } from "@eveland/platform-observability";
import type { ApiApp, AppOptions } from "./app-types.js";
import { isServiceRequest } from "./app-support.js";

const maxOtlpRequestBytes = 16 * 1024 * 1024;
const otlpJsonContentType = "application/json";
const otlpProtobufContentType = "application/x-protobuf";
const signalFields = {
  traces: "resourceSpans",
  logs: "resourceLogs",
  metrics: "resourceMetrics",
} as const satisfies Record<ObservabilitySignal, string>;

export function registerOtlpRoutes(input: {
  app: ApiApp;
  store: Store;
  options: AppOptions;
  appSecretKey: string;
}): void {
  const { app, store, options } = input;
  const telemetrySecret = deriveAgentTelemetrySecret(input.appSecretKey);
  // The Agent receiver is unauthenticated by design, so the deployment an Agent
  // claims is only trusted once its Worker-issued credential verifies. A resource
  // whose credential is absent or forged projects nothing and counts as rejected.
  const resolveDeploymentId = (credential: string | undefined) =>
    credential
      ? verifyAgentTelemetryCredential(credential, telemetrySecret)
          ?.deploymentId
      : undefined;

  app.post("/internal/otel/v1/:signal", async (c) => {
    const token =
      options.otlpServiceToken ?? process.env.EVELAND_OTLP_SERVICE_TOKEN;
    if (!isServiceRequest(c.req.header("authorization"), token)) {
      return c.json({ error: "Not found" }, 404);
    }
    const signal = parseSignal(c.req.param("signal"));
    if (!signal) return c.json({ error: "Not found" }, 404);
    const contentType = c.req
      .header("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (
      contentType !== otlpJsonContentType &&
      contentType !== otlpProtobufContentType
    ) {
      return c.json(
        { error: "OTLP/HTTP JSON or protobuf is required" },
        415,
      );
    }
    const contentLength = Number(c.req.header("content-length") ?? 0);
    if (
      Number.isFinite(contentLength) &&
      contentLength > maxOtlpRequestBytes
    ) {
      return c.json({ error: "OTLP request is too large" }, 413);
    }

    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength > maxOtlpRequestBytes) {
      return c.json({ error: "OTLP request is too large" }, 413);
    }
    const payload =
      contentType === otlpProtobufContentType
        ? decodeOtlpProtobufRequest(signal, bytes)
        : parseJsonPayload(bytes);
    if (!payload || !matchesSignal(payload, signal)) {
      return c.json({ error: "Invalid OTLP request" }, 400);
    }
    return runWithPlatformTracingSuppressed(async () => {
      const receivedItems = countOtlpSignalItems(signal, payload);
      let acceptedItems = 0;
      // Built-in projects rather than stores. Every projection below still runs in
      // full: the `partial_success` rejection count is derived from how many items
      // pass projection, which is a protocol obligation independent of storage.
      await store.ingestOtlpBatch({ signal, payload });
      if (signal === "traces") {
        // Traces have no Built-in read model: platform spans go to external
        // destinations only. The projection runs solely for the rejection count.
        acceptedItems = projectOtlpSpans(payload).length;
      }
      if (signal === "logs") {
        for (const observation of projectAgentEventItemsFromOtlpLogs(payload, {
          resolveDeploymentId,
        })) {
          if (!observation) continue;
          try {
            await store.ingestAgentEvent(observation);
            acceptedItems += 1;
          } catch (error) {
            if (error instanceof UnmanagedTelemetryResourceError) continue;
            throw error;
          }
        }
      }
      if (signal === "metrics") {
        const projection =
          projectInstanceTelemetryFromOtlpMetrics(payload);
        await Promise.all([
          ...projection.heartbeats.map((heartbeat) =>
            store.upsertWorkerHeartbeat(heartbeat),
          ),
          ...projection.hostMetrics.map((sample) =>
            store.recordHostMetric(sample),
          ),
        ]);
        acceptedItems = projection.acceptedDataPoints;
      }
      const response = createOtlpPartialSuccessResponse(
        signal,
        Math.max(0, receivedItems - acceptedItems),
      );
      if (contentType === otlpProtobufContentType) {
        const encoded = encodeOtlpProtobufResponse(signal, response);
        return c.body(Uint8Array.from(encoded).buffer, 200, {
          "content-type": otlpProtobufContentType,
        });
      }
      return c.json(response);
    });
  });
}

function parseSignal(value: string): ObservabilitySignal | null {
  return value === "traces" || value === "logs" || value === "metrics"
    ? value
    : null;
}

function parseJsonPayload(
  bytes: Uint8Array,
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function matchesSignal(
  payload: Record<string, unknown>,
  signal: ObservabilitySignal,
): boolean {
  const expected = signalFields[signal];
  if (expected in payload && !Array.isArray(payload[expected])) return false;
  return Object.values(signalFields).every(
    (field) => field === expected || !(field in payload),
  );
}
