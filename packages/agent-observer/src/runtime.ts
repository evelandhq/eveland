import {
  type AgentTelemetryEvent,
  type AgentTelemetryHookContext,
  type PrivateAgentTelemetryExporters,
  type PrivateAgentTelemetryRuntime,
  type RuntimeAgentPolicy,
} from "./runtime/contracts.js";
import { mapAgentTelemetryLifecycle } from "./runtime/lifecycle.js";
import { emitAgentTelemetryEventLog, shouldCollectAgentTelemetryEvent } from "./runtime/logs.js";
import { createAgentTelemetryMetrics } from "./runtime/metrics.js";
import {
  modelCallCapture,
  type ModelCallCapture,
  type ObservedModelCall,
} from "./runtime/model-capture.js";
import { createAgentTelemetryProviders } from "./runtime/provider.js";
import { createAgentTelemetryRuntimeState, endAllAgentTelemetrySpans } from "./runtime/spans.js";
import { asRecord, asString } from "./runtime/values.js";

export type {
  AgentTelemetryEvent,
  AgentTelemetryHookContext,
  PrivateAgentTelemetryExporters,
  PrivateAgentTelemetryRuntime,
  RuntimeAgentPolicy,
} from "./runtime/contracts.js";

export function createPrivateAgentTelemetryRuntime(input: {
  policy: RuntimeAgentPolicy;
  exporters?: PrivateAgentTelemetryExporters;
  runtimeInstanceId?: string;
  warn?: (error: unknown) => void;
  now?: () => number;
  modelCapture?: ModelCallCapture;
}): PrivateAgentTelemetryRuntime {
  const { policy } = input;
  const modelCapture = input.modelCapture ?? modelCallCapture;
  const providers = createAgentTelemetryProviders({
    policy,
    exporters: input.exporters,
    runtimeInstanceId: input.runtimeInstanceId,
  });
  const metrics = createAgentTelemetryMetrics(providers.meter);
  const state = createAgentTelemetryRuntimeState();
  const now = input.now ?? Date.now;
  let stopped = false;

  async function capture(
    event: AgentTelemetryEvent,
    context: AgentTelemetryHookContext,
  ): Promise<void> {
    if (stopped || !policy.capture.enabled) return;
    try {
      const eventType = asString(event.type);
      if (!eventType) return;
      const data = asRecord(event.data) ?? {};
      if (!shouldCollectAgentTelemetryEvent(eventType, data, policy.capture.recordOutputs)) {
        return;
      }
      const sessionId = asString(context.session?.id);
      if (!sessionId) return;
      let observedModel: ObservedModelCall | undefined;
      const correlatedSpan = mapAgentTelemetryLifecycle({
        eventType,
        data,
        scope: asRecord(event.scope),
        sessionId,
        context,
        state,
        tracer: providers.tracer,
        metrics,
        now,
        capture: policy.capture,
        modelCapture,
        onObservedModel: (observed) => {
          observedModel = observed;
        },
      });
      emitAgentTelemetryEventLog({
        eventType,
        event,
        context,
        sessionId,
        correlatedSpan,
        logger: providers.logger,
        policy,
        observedModel,
      });
    } catch (error) {
      input.warn?.(error);
    }
  }

  async function forceFlush(): Promise<void> {
    if (stopped) return;
    await providers.forceFlush();
  }

  async function shutdown(): Promise<void> {
    if (stopped) return;
    stopped = true;
    endAllAgentTelemetrySpans(state);
    await providers.shutdown();
  }

  return { capture, forceFlush, shutdown };
}
