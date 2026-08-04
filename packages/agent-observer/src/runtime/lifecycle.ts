import { SpanKind, type Span } from "@opentelemetry/api";
import type { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import {
  ATTR_ERROR_TYPE,
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_CALL_RESULT,
  ATTR_GEN_AI_TOOL_NAME,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
  GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
} from "@opentelemetry/semantic-conventions/incubating";
import { commonAttributes } from "./attributes.js";
import type { AgentTelemetryHookContext, RuntimeAgentPolicy } from "./contracts.js";
import {
  compactionMessage,
  mapFinishReason,
  reconstructedInputAttributes,
  recordToolCall,
  serializedTextMessage,
  stepAssistantFor,
  textMessage,
  toOutputMessage,
  transcriptFor,
} from "./messages.js";
import { recordUsage, type AgentTelemetryMetrics } from "./metrics.js";
import type { ObservedModelCall } from "./model-capture.js";
import {
  endSessionSpans,
  endTurnChildren,
  parentContext,
  setErrorStatus,
  spanContext,
  spanKey,
  type AgentTelemetryRuntimeState,
} from "./spans.js";
import { asNonNegativeInteger, asRecord, asString, serializeAttribute } from "./values.js";

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
  observedModel?: ObservedModelCall;
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
    observedModel,
  } = input;
  const turnId = asString(data.turnId);
  const stepIndex = asNonNegativeInteger(data.stepIndex);
  const turnKey = turnId ? spanKey(sessionId, turnId) : undefined;
  const stepKey =
    turnId && stepIndex !== undefined ? spanKey(sessionId, turnId, String(stepIndex)) : undefined;

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
        asString(asRecord(data.runtime)?.agentName) ?? asString(context.agent?.name) ?? "agent";
      const span = tracer.startSpan(
        `invoke_agent ${agentName}`,
        {
          kind: SpanKind.INTERNAL,
          attributes: commonAttributes(sessionId, turnId, context, {
            [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
            [ATTR_GEN_AI_AGENT_NAME]: agentName,
          }),
        },
        parentContext(context, state),
      );
      state.turns.set(turnKey, span);
      state.turnStartedAt.set(turnKey, now());
      metrics.agentInvocations.add(1, {
        [ATTR_GEN_AI_AGENT_NAME]: agentName,
      });
      return span;
    }
    case "message.received": {
      const span = turnKey ? state.turns.get(turnKey) : undefined;
      const message = asString(data.message);
      if (turnKey && message) {
        transcriptFor(state, turnKey).push({
          role: "user",
          parts: capture.recordInputs ? [{ type: "text", content: message }] : [],
        });
      }
      if (span && message && capture.recordInputs) {
        span.setAttribute(
          ATTR_GEN_AI_INPUT_MESSAGES,
          serializeAttribute([textMessage("user", message)]),
        );
      }
      return span;
    }
    case "step.started": {
      if (!turnId || stepIndex === undefined || !stepKey || state.steps.has(stepKey)) {
        return turnKey ? state.turns.get(turnKey) : undefined;
      }
      const modelId = state.sessionModels.get(sessionId);
      const span = tracer.startSpan(
        modelId ? `chat ${modelId}` : "chat",
        {
          kind: SpanKind.CLIENT,
          attributes: commonAttributes(sessionId, turnId, context, {
            [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_CHAT,
            ...(modelId ? { [ATTR_GEN_AI_REQUEST_MODEL]: modelId } : {}),
            "eveland.eve.step.index": stepIndex,
          }),
        },
        spanContext(turnKey ? state.turns.get(turnKey) : undefined),
      );
      const reconstructed =
        capture.recordInputs && turnKey ? reconstructedInputAttributes(state, turnKey) : undefined;
      if (reconstructed) span.setAttributes(reconstructed);
      state.steps.set(stepKey, span);
      state.stepStartedAt.set(stepKey, now());
      return span;
    }
    case "actions.requested": {
      const actions = Array.isArray(data.actions) ? data.actions : [];
      // Falls back to the turn for actions the runtime dispatches after the step closed.
      const actionParent = spanContext(
        (stepKey ? state.steps.get(stepKey) : undefined) ??
          (turnKey ? state.turns.get(turnKey) : undefined),
      );
      for (const value of actions) {
        const action = asRecord(value);
        const callId = asString(action?.callId);
        if (!action || !callId) continue;
        const actionKey = spanKey(sessionId, callId);
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
                [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
                [ATTR_GEN_AI_AGENT_NAME]: agentName,
                [ATTR_GEN_AI_TOOL_CALL_ID]: callId,
              }),
            },
            actionParent,
          );
          if (capture.recordInputs && action.input !== undefined) {
            span.setAttribute(
              ATTR_GEN_AI_INPUT_MESSAGES,
              serializeAttribute([serializedTextMessage("user", action.input)]),
            );
          }
          state.subagents.set(actionKey, span);
          state.actionToolNames.set(actionKey, agentName);
          recordToolCall(state, {
            stepKey,
            turnKey,
            callId,
            toolName: agentName,
            ...(capture.recordInputs && action.input !== undefined
              ? { arguments: action.input }
              : {}),
          });
          continue;
        }
        if (state.actions.has(actionKey)) continue;
        const toolName =
          asString(action.toolName) ?? (kind === "load-skill" ? "load_skill" : "tool");
        const span = tracer.startSpan(
          `execute_tool ${toolName}`,
          {
            kind: SpanKind.INTERNAL,
            attributes: commonAttributes(sessionId, turnId, context, {
              [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
              [ATTR_GEN_AI_TOOL_NAME]: toolName,
              [ATTR_GEN_AI_TOOL_CALL_ID]: callId,
            }),
          },
          actionParent,
        );
        if (capture.recordInputs && action.input !== undefined) {
          span.setAttribute(ATTR_GEN_AI_TOOL_CALL_ARGUMENTS, serializeAttribute(action.input));
        }
        state.actions.set(actionKey, span);
        state.actionToolNames.set(actionKey, toolName);
        recordToolCall(state, {
          stepKey,
          turnKey,
          callId,
          toolName,
          ...(capture.recordInputs && action.input !== undefined
            ? { arguments: action.input }
            : {}),
        });
        metrics.toolCalls.add(1, {
          [ATTR_GEN_AI_TOOL_NAME]: toolName,
        });
      }
      return stepKey
        ? (state.steps.get(stepKey) ?? (turnKey ? state.turns.get(turnKey) : undefined))
        : turnKey
          ? state.turns.get(turnKey)
          : undefined;
    }
    case "action.result": {
      const result = asRecord(data.result);
      const callId = asString(result?.callId);
      if (!callId) return turnKey ? state.turns.get(turnKey) : undefined;
      const actionKey = spanKey(sessionId, callId);
      const span = state.actions.get(actionKey) ?? state.subagents.get(actionKey);
      if (turnKey) {
        const toolName = state.actionToolNames.get(actionKey);
        transcriptFor(state, turnKey).push({
          role: "tool",
          ...(toolName ? { name: toolName } : {}),
          parts: [
            {
              type: "tool_call_response",
              id: callId,
              response: capture.recordOutputs ? (result?.output ?? null) : null,
            },
          ],
        });
      }
      state.actionToolNames.delete(actionKey);
      if (span) {
        if (capture.recordOutputs && result?.output !== undefined) {
          if (state.actions.has(actionKey)) {
            span.setAttribute(ATTR_GEN_AI_TOOL_CALL_RESULT, serializeAttribute(result.output));
          } else {
            span.setAttribute(
              ATTR_GEN_AI_OUTPUT_MESSAGES,
              serializeAttribute([
                toOutputMessage(serializedTextMessage("assistant", result.output)),
              ]),
            );
          }
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
        stepAssistantFor(state, stepKey, turnKey).parts.push({ type: "text", content: message });
        if (turnKey) {
          state.turns.get(turnKey)?.setAttribute(
            ATTR_GEN_AI_OUTPUT_MESSAGES,
            serializeAttribute([
              toOutputMessage({
                ...textMessage("assistant", message),
                finish_reason: mapFinishReason(asString(data.finishReason)),
              }),
            ]),
          );
        }
      }
      return span ?? (turnKey ? state.turns.get(turnKey) : undefined);
    }
    case "reasoning.completed": {
      const span = stepKey ? state.steps.get(stepKey) : undefined;
      const reasoning = asString(data.reasoning);
      if (reasoning && capture.recordOutputs) {
        stepAssistantFor(state, stepKey, turnKey).parts.push({
          type: "reasoning",
          content: reasoning,
        });
      }
      return span;
    }
    case "compaction.completed": {
      // Eve replaced the visible history with a checkpoint the event stream never
      // exposes, so the reconstruction drops what the model can no longer see. A step
      // still holding an assistant message keeps it: that output really was produced.
      if (turnKey) {
        state.transcripts.set(turnKey, [compactionMessage()]);
      }
      return stepKey
        ? (state.steps.get(stepKey) ?? (turnKey ? state.turns.get(turnKey) : undefined))
        : turnKey
          ? state.turns.get(turnKey)
          : undefined;
    }
    case "subagent.called":
    case "subagent.started": {
      const callId = asString(data.callId);
      if (!callId) return turnKey ? state.turns.get(turnKey) : undefined;
      const actionKey = spanKey(sessionId, callId);
      const existing = state.subagents.get(actionKey);
      if (existing) return existing;
      const agentName = asString(data.name) ?? asString(data.subagentName) ?? "subagent";
      const span = tracer.startSpan(
        `invoke_agent ${agentName}`,
        {
          kind: SpanKind.INTERNAL,
          attributes: commonAttributes(sessionId, turnId, context, {
            [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
            [ATTR_GEN_AI_AGENT_NAME]: agentName,
            [ATTR_GEN_AI_TOOL_CALL_ID]: callId,
          }),
        },
        spanContext(turnKey ? state.turns.get(turnKey) : undefined),
      );
      state.subagents.set(actionKey, span);
      return span;
    }
    case "subagent.completed": {
      const callId = asString(data.callId);
      const actionKey = callId ? spanKey(sessionId, callId) : undefined;
      const span = actionKey ? state.subagents.get(actionKey) : undefined;
      if (span) {
        if (capture.recordOutputs && data.output !== undefined) {
          span.setAttribute(
            ATTR_GEN_AI_OUTPUT_MESSAGES,
            serializeAttribute([toOutputMessage(serializedTextMessage("assistant", data.output))]),
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
        const assistant = stepKey ? state.stepAssistants.get(stepKey) : undefined;
        if (assistant && capture.recordOutputs) {
          assistant.finish_reason =
            mapFinishReason(asString(data.finishReason)) ??
            (eventType === "step.failed" ? "error" : undefined) ??
            assistant.finish_reason;
          span.setAttribute(
            ATTR_GEN_AI_OUTPUT_MESSAGES,
            serializeAttribute([toOutputMessage(assistant)]),
          );
        }
        if (stepKey) state.stepAssistants.delete(stepKey);
        if (eventType === "step.failed") setErrorStatus(span, data);
        if (eventType === "step.completed") {
          if (observedModel) {
            state.sessionModels.set(sessionId, observedModel.modelId);
            span.updateName(`chat ${observedModel.modelId}`);
            span.setAttribute(ATTR_GEN_AI_REQUEST_MODEL, observedModel.modelId);
            if (observedModel.responseModelId) {
              span.setAttribute(ATTR_GEN_AI_RESPONSE_MODEL, observedModel.responseModelId);
            }
          }
          recordUsage({
            data,
            modelId: state.sessionModels.get(sessionId),
            span,
            metrics,
          });
        }
        const startedAt = state.stepStartedAt.get(stepKey!);
        if (startedAt !== undefined) {
          metrics.operationDuration.record(Math.max(0, now() - startedAt) / 1_000, {
            ...(state.sessionModels.get(sessionId)
              ? {
                  [ATTR_GEN_AI_REQUEST_MODEL]: state.sessionModels.get(sessionId)!,
                }
              : {}),
            [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_CHAT,
            [ATTR_ERROR_TYPE]:
              eventType === "step.failed" ? (asString(data.code) ?? "unknown") : "",
          });
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
            [ATTR_GEN_AI_AGENT_NAME]: asString(context.agent?.name) ?? "agent",
            [ATTR_ERROR_TYPE]: asString(data.code) ?? "unknown",
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
        ? (state.steps.get(stepKey) ?? (turnKey ? state.turns.get(turnKey) : undefined))
        : turnKey
          ? state.turns.get(turnKey)
          : undefined;
  }
}
