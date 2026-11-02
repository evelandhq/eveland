import type { AgentRuntimePolicy } from "@evelandhq/core/observability";
import type { LogRecordExporter } from "@opentelemetry/sdk-logs";
import type { PushMetricExporter } from "@opentelemetry/sdk-metrics";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";

export type RuntimeAgentPolicy = AgentRuntimePolicy;

export type AgentTelemetryEvent = {
  type?: unknown;
  /** v27: the owners the fact belongs to (`turnId`, `runId`, `taskId`, `changeId`). */
  scope?: unknown;
  data?: unknown;
  meta?: {
    at?: unknown;
  };
};

export type AgentTelemetryHookContext = {
  session?: {
    id?: unknown;
    parent?: {
      sessionId?: unknown;
      rootSessionId?: unknown;
      callId?: unknown;
    };
  };
  agent?: {
    name?: unknown;
    nodeId?: unknown;
  };
  channel?: {
    kind?: unknown;
  };
  /** v27 (eve 0.84+): where the event sits on the session stream. */
  position?: {
    line?: unknown;
    index?: unknown;
  };
  /** v27 (eve 0.84+): when eve recorded the event. */
  now?: unknown;
};

export type PrivateAgentTelemetryExporters = {
  traces: SpanExporter;
  logs: LogRecordExporter;
  metrics: PushMetricExporter;
};

export type PrivateAgentTelemetryRuntime = {
  capture(event: AgentTelemetryEvent, context: AgentTelemetryHookContext): Promise<void>;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
};
