import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api";
import type { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import type {
  AgentTelemetryHookContext,
  RuntimeAgentPolicy,
} from "./contracts.js";
import {
  recordUsage,
  type AgentTelemetryMetrics,
} from "./metrics.js";
import {
  asNonNegativeInteger,
  asRecord,
  asString,
  serializeAttribute,
} from "./values.js";

export type AgentTelemetryRuntimeState = {
  sessionModels: Map<string, string>;
  turns: Map<string, Span>;
  turnStartedAt: Map<string, number>;
  steps: Map<string, Span>;
  stepStartedAt: Map<string, number>;
  actions: Map<string, Span>;
  subagents: Map<string, Span>;
};

export function createAgentTelemetryRuntimeState(): AgentTelemetryRuntimeState {
  return {
    sessionModels: new Map(),
    turns: new Map(),
    turnStartedAt: new Map(),
    steps: new Map(),
    stepStartedAt: new Map(),
    actions: new Map(),
    subagents: new Map(),
  };
}

export function mapAgentTelemetryLifecycle(input: {
  eventType: string;
  data: Record<string, unknown>;
  sessionId: string;
  context: AgentTelemetryHookContext;
  state: AgentTelemetryRuntimeState;
  tracer: ReturnType<BasicTracerProvider["getTracer"]>;
  metrics: AgentTelemetryMetrics;
  now: () => number;
  capture: RuntimeAgentPolicy["capture"];
}): Span | undefined {
  const {
    eventType,
    data,
    sessionId,
    context,
    state,
    tracer,
    metrics,
    now,
    capture,
  } = input;
  const turnId = asString(data.turnId);
  const stepIndex = asNonNegativeInteger(data.stepIndex);
  const turnKey = turnId ? key(sessionId, turnId) : undefined;
  const stepKey =
    turnId && stepIndex !== undefined
      ? key(sessionId, turnId, String(stepIndex))
      : undefined;

  switch (eventType) {
    case "session.started": {
      const runtime = asRecord(data.runtime);
      const modelId = asString(runtime?.modelId);
      if (modelId) state.sessionModels.set(sessionId, modelId);
      return undefined;
    }
    case "turn.started": {
      if (!turnId || !turnKey || state.turns.has(turnKey)) return undefined;
      const agentName =
        asString(asRecord(data.runtime)?.agentName) ??
        asString(context.agent?.name) ??
        "agent";
      const span = tracer.startSpan(
        `invoke_agent ${agentName}`,
        {
          kind: SpanKind.INTERNAL,
          attributes: commonAttributes(sessionId, turnId, context, {
            "gen_ai.operation.name": "invoke_agent",
            "gen_ai.agent.name": agentName,
          }),
        },
        parentContext(context, state),
      );
      state.turns.set(turnKey, span);
      state.turnStartedAt.set(turnKey, now());
      metrics.agentInvocations.add(1, {
        "gen_ai.agent.name": agentName,
      });
      return span;
    }
    case "message.received": {
      const span = turnKey ? state.turns.get(turnKey) : undefined;
      const message = asString(data.message);
      if (span && message && capture.recordInputs) {
        span.setAttribute(
          "gen_ai.input.messages",
          serializeAttribute([{ role: "user", content: message }]),
        );
      }
      return span;
    }
    case "step.started": {
      if (
        !turnId ||
        stepIndex === undefined ||
        !stepKey ||
        state.steps.has(stepKey)
      ) {
        return turnKey ? state.turns.get(turnKey) : undefined;
      }
      const modelId = state.sessionModels.get(sessionId);
      const span = tracer.startSpan(
        modelId ? `chat ${modelId}` : "chat",
        {
          kind: SpanKind.CLIENT,
          attributes: commonAttributes(sessionId, turnId, context, {
            "gen_ai.operation.name": "chat",
            ...(modelId ? { "gen_ai.request.model": modelId } : {}),
            "eveland.eve.step.index": stepIndex,
          }),
        },
        spanContext(turnKey ? state.turns.get(turnKey) : undefined),
      );
      state.steps.set(stepKey, span);
      state.stepStartedAt.set(stepKey, now());
      return span;
    }
    case "actions.requested": {
      const actions = Array.isArray(data.actions) ? data.actions : [];
      for (const value of actions) {
        const action = asRecord(value);
        const callId = asString(action?.callId);
        if (!action || !callId) continue;
        const actionKey = key(sessionId, callId);
        const kind = asString(action.kind);
        if (kind === "subagent-call" || kind === "remote-agent-call") {
          if (state.subagents.has(actionKey)) continue;
          const agentName =
            asString(action.subagentName) ??
            asString(action.remoteAgentName) ??
            asString(action.name) ??
            "subagent";
          const span = tracer.startSpan(
            `invoke_agent ${agentName}`,
            {
              kind: SpanKind.INTERNAL,
              attributes: commonAttributes(sessionId, turnId, context, {
                "gen_ai.operation.name": "invoke_agent",
                "gen_ai.agent.name": agentName,
                "gen_ai.tool.call.id": callId,
              }),
            },
            spanContext(turnKey ? state.turns.get(turnKey) : undefined),
          );
          if (capture.recordInputs && action.input !== undefined) {
            span.setAttribute(
              "gen_ai.agent.input",
              serializeAttribute(action.input),
            );
          }
          state.subagents.set(actionKey, span);
          continue;
        }
        if (state.actions.has(actionKey)) continue;
        const toolName =
          asString(action.toolName) ??
          (kind === "load-skill" ? "load_skill" : "tool");
        const span = tracer.startSpan(
          `execute_tool ${toolName}`,
          {
            kind: SpanKind.INTERNAL,
            attributes: commonAttributes(sessionId, turnId, context, {
              "gen_ai.operation.name": "execute_tool",
              "gen_ai.tool.name": toolName,
              "gen_ai.tool.call.id": callId,
            }),
          },
          spanContext(turnKey ? state.turns.get(turnKey) : undefined),
        );
        if (capture.recordInputs && action.input !== undefined) {
          span.setAttribute(
            "gen_ai.tool.call.arguments",
            serializeAttribute(action.input),
          );
        }
        state.actions.set(actionKey, span);
        metrics.toolCalls.add(1, {
          "gen_ai.tool.name": toolName,
        });
      }
      return stepKey
        ? state.steps.get(stepKey) ??
            (turnKey ? state.turns.get(turnKey) : undefined)
        : turnKey
          ? state.turns.get(turnKey)
          : undefined;
    }
    case "action.result": {
      const result = asRecord(data.result);
      const callId = asString(result?.callId);
      if (!callId) return turnKey ? state.turns.get(turnKey) : undefined;
      const actionKey = key(sessionId, callId);
      const span =
        state.actions.get(actionKey) ?? state.subagents.get(actionKey);
      if (span) {
        if (capture.recordOutputs && result?.output !== undefined) {
          span.setAttribute(
            state.actions.has(actionKey)
              ? "gen_ai.tool.call.result"
              : "gen_ai.agent.output",
            serializeAttribute(result.output),
          );
        }
        if (data.status !== "completed" || data.error !== undefined) {
          setErrorStatus(span, data);
        }
        span.end();
        state.actions.delete(actionKey);
        state.subagents.delete(actionKey);
      }
      return span;
    }
    case "message.completed": {
      const message = asString(data.message);
      const span = stepKey ? state.steps.get(stepKey) : undefined;
      if (message && capture.recordOutputs) {
        const output = serializeAttribute([
          { role: "assistant", content: message },
        ]);
        span?.setAttribute("gen_ai.output.messages", output);
        if (turnKey) {
          state.turns
            .get(turnKey)
            ?.setAttribute("gen_ai.output.messages", output);
        }
      }
      return span ?? (turnKey ? state.turns.get(turnKey) : undefined);
    }
    case "reasoning.completed": {
      const span = stepKey ? state.steps.get(stepKey) : undefined;
      const reasoning = asString(data.reasoning);
      if (span && reasoning && capture.includeReasoning) {
        span.setAttribute(
          "eveland.gen_ai.reasoning",
          serializeAttribute(reasoning),
        );
      }
      return span;
    }
    case "subagent.called":
    case "subagent.started": {
      const callId = asString(data.callId);
      if (!callId) return turnKey ? state.turns.get(turnKey) : undefined;
      const actionKey = key(sessionId, callId);
      const existing = state.subagents.get(actionKey);
      if (existing) return existing;
      const agentName =
        asString(data.name) ?? asString(data.subagentName) ?? "subagent";
      const span = tracer.startSpan(
        `invoke_agent ${agentName}`,
        {
          kind: SpanKind.INTERNAL,
          attributes: commonAttributes(sessionId, turnId, context, {
            "gen_ai.operation.name": "invoke_agent",
            "gen_ai.agent.name": agentName,
            "gen_ai.tool.call.id": callId,
          }),
        },
        spanContext(turnKey ? state.turns.get(turnKey) : undefined),
      );
      state.subagents.set(actionKey, span);
      return span;
    }
    case "subagent.completed": {
      const callId = asString(data.callId);
      const actionKey = callId ? key(sessionId, callId) : undefined;
      const span = actionKey ? state.subagents.get(actionKey) : undefined;
      if (span) {
        if (capture.recordOutputs && data.output !== undefined) {
          span.setAttribute(
            "gen_ai.agent.output",
            serializeAttribute(data.output),
          );
        }
        span.end();
        state.subagents.delete(actionKey!);
      }
      return span;
    }
    case "step.completed":
    case "step.failed": {
      const span = stepKey ? state.steps.get(stepKey) : undefined;
      if (span) {
        if (eventType === "step.failed") setErrorStatus(span, data);
        if (eventType === "step.completed") {
          recordUsage({
            data,
            modelId: state.sessionModels.get(sessionId),
            span,
            metrics,
          });
        }
        const startedAt = state.stepStartedAt.get(stepKey!);
        if (startedAt !== undefined) {
          metrics.operationDuration.record(
            Math.max(0, now() - startedAt) / 1_000,
            {
              ...(state.sessionModels.get(sessionId)
                ? {
                    "gen_ai.request.model":
                      state.sessionModels.get(sessionId)!,
                  }
                : {}),
              "gen_ai.operation.name": "chat",
              "error.type":
                eventType === "step.failed"
                  ? asString(data.code) ?? "unknown"
                  : "",
            },
          );
        }
        span.end();
        state.steps.delete(stepKey!);
        state.stepStartedAt.delete(stepKey!);
      }
      return span;
    }
    case "turn.completed":
    case "turn.failed":
    case "turn.cancelled": {
      if (!turnKey || !turnId) return undefined;
      endTurnChildren(state, sessionId, turnId);
      const span = state.turns.get(turnKey);
      if (span) {
        if (eventType === "turn.failed") {
          setErrorStatus(span, data);
          metrics.agentFailures.add(1, {
            "gen_ai.agent.name": asString(context.agent?.name) ?? "agent",
            "error.type": asString(data.code) ?? "unknown",
          });
        }
        if (eventType === "turn.cancelled") {
          span.setAttribute("eveland.turn.cancelled", true);
        }
        span.end();
        state.turns.delete(turnKey);
        state.turnStartedAt.delete(turnKey);
      }
      return span;
    }
    case "session.failed":
    case "session.completed": {
      endSessionSpans(state, sessionId, eventType === "session.failed", data);
      state.sessionModels.delete(sessionId);
      return undefined;
    }
    default:
      return stepKey
        ? state.steps.get(stepKey) ??
            (turnKey ? state.turns.get(turnKey) : undefined)
        : turnKey
          ? state.turns.get(turnKey)
          : undefined;
  }
}

export function commonAttributes(
  sessionId: string,
  turnId: string | undefined,
  context: AgentTelemetryHookContext,
  attributes: Attributes,
): Attributes {
  const agentName = asString(context.agent?.name);
  const agentNodeId = asString(context.agent?.nodeId);
  const channelKind = asString(context.channel?.kind);
  return {
    ...attributes,
    "gen_ai.conversation.id": sessionId,
    "session.id": sessionId,
    "eveland.eve.session.id": sessionId,
    ...(turnId ? { "eveland.eve.turn.id": turnId } : {}),
    ...(agentName
      ? {
          "gen_ai.agent.name": agentName,
          "eveland.eve.agent.name": agentName,
        }
      : {}),
    ...(agentNodeId
      ? { "eveland.eve.agent.node.id": agentNodeId }
      : {}),
    ...(channelKind
      ? { "eveland.eve.channel.kind": channelKind }
      : {}),
  };
}

export function endAllAgentTelemetrySpans(
  state: AgentTelemetryRuntimeState,
): void {
  for (const spans of [
    state.steps,
    state.actions,
    state.subagents,
    state.turns,
  ]) {
    for (const span of spans.values()) span.end();
    spans.clear();
  }
  state.stepStartedAt.clear();
  state.turnStartedAt.clear();
}

function parentContext(
  context: AgentTelemetryHookContext,
  state: AgentTelemetryRuntimeState,
): Context {
  const parentSessionId = asString(context.session?.parent?.sessionId);
  const callId = asString(context.session?.parent?.callId);
  return spanContext(
    parentSessionId && callId
      ? state.subagents.get(key(parentSessionId, callId))
      : undefined,
  );
}

function spanContext(span: Span | undefined): Context {
  return span ? trace.setSpan(ROOT_CONTEXT, span) : ROOT_CONTEXT;
}

function setErrorStatus(span: Span, data: Record<string, unknown>): void {
  const error = asRecord(data.error);
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message:
      asString(error?.message) ??
      asString(data.message) ??
      asString(data.status) ??
      "Eve operation failed",
  });
}

function endTurnChildren(
  state: AgentTelemetryRuntimeState,
  sessionId: string,
  turnId: string,
): void {
  const prefix = key(sessionId, turnId);
  for (const [stepKey, span] of state.steps) {
    if (!stepKey.startsWith(`${prefix}\0`)) continue;
    span.end();
    state.steps.delete(stepKey);
    state.stepStartedAt.delete(stepKey);
  }
  const sessionPrefix = `${sessionId}\0`;
  for (const spans of [state.actions, state.subagents]) {
    for (const [spanKey, span] of spans) {
      if (!spanKey.startsWith(sessionPrefix)) continue;
      span.end();
      spans.delete(spanKey);
    }
  }
}

function endSessionSpans(
  state: AgentTelemetryRuntimeState,
  sessionId: string,
  failed: boolean,
  data: Record<string, unknown>,
): void {
  const prefix = `${sessionId}\0`;
  for (const spans of [
    state.steps,
    state.actions,
    state.subagents,
    state.turns,
  ]) {
    for (const [spanKey, span] of spans) {
      if (!spanKey.startsWith(prefix)) continue;
      if (failed) setErrorStatus(span, data);
      span.end();
      spans.delete(spanKey);
    }
  }
  for (const startedAt of [state.stepStartedAt, state.turnStartedAt]) {
    for (const startedAtKey of startedAt.keys()) {
      if (startedAtKey.startsWith(prefix)) startedAt.delete(startedAtKey);
    }
  }
}

function key(...parts: string[]): string {
  return parts.join("\0");
}
