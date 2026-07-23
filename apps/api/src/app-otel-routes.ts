import {
  UnmanagedTelemetryResourceError,
  type ObservabilitySignal,
} from "@eveland/core/observability";
import type { Store } from "@eveland/db";
import {
  projectAgentEventsFromOtlpLogs,
  projectInstanceTelemetryFromOtlpMetrics,
} from "@eveland/session-collector";
import { runWithPlatformTracingSuppressed } from "@eveland/platform-observability";
import type { ApiApp, AppOptions } from "./app-types.js";
import { isServiceRequest } from "./app-support.js";

const maxOtlpRequestBytes = 16 * 1024 * 1024;
const signalFields = {
  traces: "resourceSpans",
  logs: "resourceLogs",
  metrics: "resourceMetrics",
} as const satisfies Record<ObservabilitySignal, string>;

export function registerOtlpRoutes(input: {
  app: ApiApp;
  store: Store;
  options: AppOptions;
}): void {
  const { app, store, options } = input;

  app.post("/internal/otel/v1/:signal", async (c) => {
    const token =
      options.otlpServiceToken ?? process.env.EVELAND_OTLP_SERVICE_TOKEN;
    if (!isServiceRequest(c.req.header("authorization"), token)) {
      return c.json({ error: "Not found" }, 404);
    }
    const signal = parseSignal(c.req.param("signal"));
    if (!signal) return c.json({ error: "Not found" }, 404);
    if (
      c.req.header("content-type")?.split(";", 1)[0]?.trim() !==
      "application/json"
    ) {
      return c.json({ error: "OTLP/HTTP JSON is required" }, 415);
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
    const payload = parsePayload(bytes);
    if (!payload || !matchesSignal(payload, signal)) {
      return c.json({ error: "Invalid OTLP request" }, 400);
    }
    return runWithPlatformTracingSuppressed(async () => {
      await store.ingestOtlpBatch({ signal, payload });
      if (signal === "logs") {
        for (const observation of projectAgentEventsFromOtlpLogs(payload)) {
          try {
            await store.ingestAgentEvent(observation);
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
      }
      return c.json({});
    });
  });
}

function parseSignal(value: string): ObservabilitySignal | null {
  return value === "traces" || value === "logs" || value === "metrics"
    ? value
    : null;
}

function parsePayload(bytes: Uint8Array): Record<string, unknown> | null {
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
