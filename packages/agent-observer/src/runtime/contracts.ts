import type { AgentRuntimePolicy } from "@evelandhq/core/observability";
import type { LogRecordExporter } from "@opentelemetry/sdk-logs";
import type { PushMetricExporter } from "@opentelemetry/sdk-metrics";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";

export type RuntimeAgentPolicy = AgentRuntimePolicy;

export type AgentTelemetryEvent = {
  type?: unknown;
  /** The owners the fact belongs to (`turnId`, `runId`, `taskId`, `changeId`). */
  scope?: unknown;
  data?: unknown;
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
  /** Where the event sits on the session stream. */
  position?: {
    line?: unknown;
    index?: unknown;
  };
  /** When eve recorded the event. */
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
