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
  type TranscriptMessage,
} from "./messages.js";
import { recordUsage, type AgentTelemetryMetrics } from "./metrics.js";
import type { ModelCallCapture, ObservedModelCall } from "./model-capture.js";
import {
  endSessionSpans,
  endTurnChildren,
  parentContext,
  setErrorStatus,
  spanContext,
  spanKey,
  taskKey,
  type AgentTelemetryRuntimeState,
} from "./spans.js";
import { asNonNegativeInteger, asRecord, asString, serializeAttribute } from "./values.js";

/**
 * The v27 session protocol (eve 0.84 and later, so every 1.x): facts are
 * `{ type, scope?, data }` envelopes, each item ends with one settled event
 * whose `outcome` says how it ended, a model call is a "run" (`model.started`
 * -> `model.settled`, keyed by `runId`, with no step index), and provider
 * usage is its own `usage.recorded` fact owned by that run.
 *
 * This maps the same span tree the v26 lifecycle builds -- an
 * `invoke_agent` span per turn, a `chat` span per model run, an
 * `execute_tool` / `invoke_agent` span per call -- so a trace reads the same
 * whichever line the Agent runs.
 */
export function mapAgentTelemetryLifecycleV27(input: {
  eventType: string;
  data: Record<string, unknown>;
  scope: Record<string, unknown> | undefined;
  sessionId: string;
  context: AgentTelemetryHookContext;
  state: AgentTelemetryRuntimeState;
  tracer: ReturnType<BasicTracerProvider["getTracer"]>;
  metrics: AgentTelemetryMetrics;
  now: () => number;
  capture: RuntimeAgentPolicy["capture"];
  modelCapture: ModelCallCapture;
  /**
   * Hands the caller the per-call model taken for a `usage.recorded`, so the
   * usage log carries it too. `take` consumes the capture, so it happens here
   * once, where the owning run and its finish reason are known.
   */
  onObservedModel?: (observed: ObservedModelCall) => void;
}): Span | undefined {
  const { eventType, data, scope, sessionId, context, state, tracer, metrics, now, capture } =
    input;
  const runId = asString(data.runId) ?? asString(scope?.runId);
  const turnId =
    asString(scope?.turnId) ??
    asString(data.turnId) ??
    (runId ? state.runTurns.get(spanKey(sessionId, runId)) : undefined);
  const turnKey = turnId ? spanKey(sessionId, turnId) : undefined;
  // Keyed under the turn so the turn's end releases its runs like it does
  // v26 steps.
  const runKey = runId ? spanKey(sessionId, turnId ?? "", "run", runId) : undefined;
  const turnSpan = turnKey ? state.turns.get(turnKey) : undefined;
  const runSpan = runKey ? state.steps.get(runKey) : undefined;

  // `usage.recorded` follows its run's `model.settled` in the same commit, so
  // a settled run's span stays open until its usage lands on it -- or until
  // any later event of the session shows that no usage is coming.
  if (eventType !== "usage.recorded") endSettledRuns(state, sessionId);

  switch (eventType) {
    case "session.started":
      return undefined;
    case "turn.started": {
      if (!turnId || !turnKey || state.turns.has(turnKey)) return turnSpan;
      const agentName = asString(context.agent?.name) ?? "agent";
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
      // The delivery that started the turn can precede `turn.started` in
      // the same commit; its text is already in the turn's transcript.
      const received = state.transcripts.get(turnKey)?.find((message) => message.role === "user");
      const receivedText = received?.parts.find((part) => part.type === "text");
      if (capture.recordInputs && receivedText?.type === "text") {
        span.setAttribute(
          ATTR_GEN_AI_INPUT_MESSAGES,
          serializeAttribute([textMessage("user", receivedText.content)]),
        );
      }
      state.turns.set(turnKey, span);
      state.turnStartedAt.set(turnKey, now());
      metrics.agentInvocations.add(1, { [ATTR_GEN_AI_AGENT_NAME]: agentName });
      return span;
    }
    case "delivery.consumed": {
      const message = textOfParts(data.parts);
      if (turnKey && message) {
        transcriptFor(state, turnKey).push({
          role: "user",
          parts: capture.recordInputs ? [{ type: "text", content: message }] : [],
        });
      }
      if (turnSpan && message && capture.recordInputs) {
        turnSpan.setAttribute(
          ATTR_GEN_AI_INPUT_MESSAGES,
          serializeAttribute([textMessage("user", message)]),
        );
      }
      return turnSpan;
    }
    case "model.requested": {
      if (runId && turnId) state.runTurns.set(spanKey(sessionId, runId), turnId);
      return turnSpan;
    }
    case "model.started": {
      if (!runId || !runKey) return turnSpan;
      if (turnId) state.runTurns.set(spanKey(sessionId, runId), turnId);
      if (state.steps.has(runKey)) return runSpan;
      const modelId = asString(data.modelId) ?? state.sessionModels.get(sessionId);
      if (modelId) {
        state.sessionModels.set(sessionId, modelId);
        state.runModels.set(runKey, modelId);
      }
      const span = tracer.startSpan(
        modelId ? `chat ${modelId}` : "chat",
        {
          kind: SpanKind.CLIENT,
          attributes: commonAttributes(sessionId, turnId, context, {
            [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_CHAT,
            ...(modelId ? { [ATTR_GEN_AI_REQUEST_MODEL]: modelId } : {}),
            "eveland.eve.run.id": runId,
          }),
        },
        spanContext(turnSpan),
      );
      const reconstructed =
        capture.recordInputs && turnKey ? reconstructedInputAttributes(state, turnKey) : undefined;
      if (reconstructed) span.setAttributes(reconstructed);
      state.steps.set(runKey, span);
      state.stepStartedAt.set(runKey, now());
      return span;
    }
    case "model.settled": {
      if (!runKey || !runSpan) return runSpan ?? turnSpan;
      const outcome = asString(data.outcome);
      const finishReason = asString(data.finishReason);
      const assistant = state.stepAssistants.get(runKey);
      if (assistant && capture.recordOutputs) {
        assistant.finish_reason =
          mapFinishReason(finishReason) ??
          (outcome === "failed" ? "error" : undefined) ??
          assistant.finish_reason;
        runSpan.setAttribute(
          ATTR_GEN_AI_OUTPUT_MESSAGES,
          serializeAttribute([toOutputMessage(assistant)]),
        );
      }
      state.stepAssistants.delete(runKey);
      if (outcome !== "completed") setErrorStatus(runSpan, data);
      const startedAt = state.stepStartedAt.get(runKey);
      if (startedAt !== undefined) {
        const modelId = state.runModels.get(runKey) ?? state.sessionModels.get(sessionId);
        metrics.operationDuration.record(Math.max(0, now() - startedAt) / 1_000, {
          ...(modelId ? { [ATTR_GEN_AI_REQUEST_MODEL]: modelId } : {}),
          [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_CHAT,
          [ATTR_ERROR_TYPE]:
            outcome === "completed"
              ? ""
              : (asString(asRecord(data.error)?.code) ?? outcome ?? "unknown"),
        });
      }
      state.settledRuns.set(runKey, { endedAt: now(), finishReason });
      return runSpan;
    }
    case "usage.recorded": {
      const owner = asRecord(data.owner);
      const ownerRunId = asString(owner?.runId);
      const ownerRunKey = ownerRunId ? findRunKey(state, sessionId, ownerRunId, turnId) : undefined;
      const span = ownerRunKey ? state.steps.get(ownerRunKey) : undefined;
      if (!ownerRunKey || !span) {
        endSettledRuns(state, sessionId);
        return turnSpan;
      }
      const usage = asRecord(data.usage);
      const settled = state.settledRuns.get(ownerRunKey);
      const observedModel = input.modelCapture.take({
        inputTokens: asNonNegativeInteger(usage?.inputTokens),
        outputTokens: asNonNegativeInteger(usage?.outputTokens),
        finishReason: settled?.finishReason,
      });
      if (observedModel) {
        input.onObservedModel?.(observedModel);
        state.runModels.set(ownerRunKey, observedModel.modelId);
        span.updateName(`chat ${observedModel.modelId}`);
        span.setAttribute(ATTR_GEN_AI_REQUEST_MODEL, observedModel.modelId);
        if (observedModel.responseModelId) {
          span.setAttribute(ATTR_GEN_AI_RESPONSE_MODEL, observedModel.responseModelId);
        }
      }
      recordUsage({
        data,
        modelId: state.runModels.get(ownerRunKey) ?? state.sessionModels.get(sessionId),
        span,
        metrics,
      });
      endSettledRuns(state, sessionId);
      return span;
    }
    case "content.completed": {
      const kind = asString(data.kind);
      const span = runSpan ?? turnSpan;
      if (!capture.recordOutputs) return span;
      // From eve 1.0.0-rc.2 a turn can write a part without a model run
      // (no `runId`); it belongs to the turn's transcript on its own.
      const assistant = () =>
        runKey || !turnKey
          ? stepAssistantFor(state, runKey, turnKey)
          : turnAssistantFor(state, turnKey);
      if (kind === "reasoning") {
        const reasoning = contentText(data);
        if (reasoning) assistant().parts.push({ type: "reasoning", content: reasoning });
        return span;
      }
      if (kind !== "text" && kind !== "result") return span;
      const text = contentText(data);
      if (!text) return span;
      assistant().parts.push({ type: "text", content: text });
      if (turnSpan && asString(data.phase) === "reply") {
        turnSpan.setAttribute(
          ATTR_GEN_AI_OUTPUT_MESSAGES,
          serializeAttribute([toOutputMessage(textMessage("assistant", text))]),
        );
      }
      return span;
    }
    case "call.requested": {
      const callId = asString(data.callId);
      if (!callId) return turnSpan;
      const actionKey = spanKey(sessionId, callId);
      if (state.actions.has(actionKey) || state.subagents.has(actionKey)) {
        return state.actions.get(actionKey) ?? state.subagents.get(actionKey);
      }
      const owner = asRecord(data.owner);
      const ownerRunId = asString(owner?.runId);
      const ownerCallId = asString(owner?.callId);
      const ownerRunKey = ownerRunId ? findRunKey(state, sessionId, ownerRunId, turnId) : undefined;
      const ownerCallKey = ownerCallId ? spanKey(sessionId, ownerCallId) : undefined;
      const parent =
        (ownerRunKey ? state.steps.get(ownerRunKey) : undefined) ??
        (ownerCallKey
          ? (state.actions.get(ownerCallKey) ?? state.subagents.get(ownerCallKey))
          : undefined) ??
        turnSpan;
      const capability = asRecord(data.capability);
      const isAgent = asString(capability?.kind) === "agent";
      const name =
        asString(capability?.name) ??
        (asString(capability?.kind) === "skill" ? "eve__skill" : isAgent ? "subagent" : "tool");
      const span = tracer.startSpan(
        isAgent ? `invoke_agent ${name}` : `execute_tool ${name}`,
        {
          kind: SpanKind.INTERNAL,
          attributes: commonAttributes(sessionId, turnId, context, {
            ...(isAgent
              ? {
                  [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
                  [ATTR_GEN_AI_AGENT_NAME]: name,
                }
              : {
                  [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
                  [ATTR_GEN_AI_TOOL_NAME]: name,
                }),
            [ATTR_GEN_AI_TOOL_CALL_ID]: callId,
          }),
        },
        spanContext(parent),
      );
      if (capture.recordInputs && data.input !== undefined) {
        span.setAttribute(
          isAgent ? ATTR_GEN_AI_INPUT_MESSAGES : ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
          serializeAttribute(isAgent ? [serializedTextMessage("user", data.input)] : data.input),
        );
      }
      (isAgent ? state.subagents : state.actions).set(actionKey, span);
      state.actionToolNames.set(actionKey, name);
      recordToolCall(state, {
        stepKey: ownerRunKey,
        turnKey,
        callId,
        toolName: name,
        ...(capture.recordInputs && data.input !== undefined ? { arguments: data.input } : {}),
      });
      if (!isAgent) metrics.toolCalls.add(1, { [ATTR_GEN_AI_TOOL_NAME]: name });
      return span;
    }
    case "call.started": {
      const callId = asString(data.callId);
      const actionKey = callId ? spanKey(sessionId, callId) : undefined;
      const span = actionKey
        ? (state.actions.get(actionKey) ?? state.subagents.get(actionKey))
        : undefined;
      const taskId = asString(data.taskId);
      if (span && taskId) span.setAttribute("eveland.eve.task.id", taskId);
      return span ?? turnSpan;
    }
    case "task.started": {
      const callId = asString(asRecord(data.startedBy)?.callId);
      if (!callId) return turnSpan;
      const actionKey = spanKey(sessionId, callId);
      const isAgent = asString(data.kind) === "agent";
      const name = asString(data.name) ?? (isAgent ? "subagent" : "tool");
      const span = state.subagents.get(actionKey) ?? state.actions.get(actionKey);
      if (span && isAgent && state.actions.has(actionKey)) {
        // The model requested the agent as an ordinary tool call; this is the
        // first event that says the call invokes an agent.
        span.updateName(`invoke_agent ${name}`);
        span.setAttributes({
          [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
          [ATTR_GEN_AI_AGENT_NAME]: name,
        });
        state.actions.delete(actionKey);
        state.subagents.set(actionKey, span);
      }
      const taskId = asString(data.taskId);
      if (taskId) {
        span?.setAttribute("eveland.eve.task.id", taskId);
        state.taskCurrentCalls.set(taskKey(sessionId, taskId), actionKey);
        state.taskCalls.add(actionKey);
      }
      return span ?? turnSpan;
    }
    case "child.opened": {
      const owner = asRecord(data.owner);
      const ownerCallId = asString(owner?.callId);
      const ownerTaskId = asString(owner?.taskId);
      const actionKey = ownerCallId
        ? spanKey(sessionId, ownerCallId)
        : ownerTaskId
          ? state.taskCurrentCalls.get(taskKey(sessionId, ownerTaskId))
          : undefined;
      if (!actionKey) return turnSpan;
      if (ownerTaskId) state.agentTasks.set(actionKey, taskKey(sessionId, ownerTaskId));
      const span = state.subagents.get(actionKey) ?? state.actions.get(actionKey);
      const childSessionId = asString(data.sessionId);
      if (span && childSessionId) span.setAttribute("eveland.eve.child_session.id", childSessionId);
      return span ?? turnSpan;
    }
    case "call.settled": {
      const callId = asString(data.callId);
      if (!callId) return turnSpan;
      const actionKey = spanKey(sessionId, callId);
      const isAgent = state.subagents.has(actionKey);
      const span = state.actions.get(actionKey) ?? state.subagents.get(actionKey);
      const outcome = asString(data.outcome);
      if (turnKey) {
        const toolName = state.actionToolNames.get(actionKey);
        transcriptFor(state, turnKey).push({
          role: "tool",
          ...(toolName ? { name: toolName } : {}),
          parts: [
            {
              type: "tool_call_response",
              id: callId,
              response: capture.recordOutputs ? (data.output ?? null) : null,
            },
          ],
        });
      }
      state.actionToolNames.delete(actionKey);
      if (!span) return turnSpan;
      if (outcome) span.setAttribute("eveland.eve.call.outcome", outcome);
      if (outcome === "completed" && capture.recordOutputs && data.output !== undefined) {
        span.setAttribute(
          isAgent ? ATTR_GEN_AI_OUTPUT_MESSAGES : ATTR_GEN_AI_TOOL_CALL_RESULT,
          serializeAttribute(
            isAgent
              ? [toOutputMessage(serializedTextMessage("assistant", data.output))]
              : data.output,
          ),
        );
      }
      if (outcome !== undefined && outcome !== "completed") setErrorStatus(span, data);
      span.end();
      state.actions.delete(actionKey);
      state.subagents.delete(actionKey);
      state.taskCalls.delete(actionKey);
      return span;
    }
    case "task.ended": {
      const taskId = asString(data.taskId);
      if (!taskId) return turnSpan;
      const key = taskKey(sessionId, taskId);
      const actionKey = state.taskCurrentCalls.get(key);
      state.taskCurrentCalls.delete(key);
      const span = actionKey
        ? (state.subagents.get(actionKey) ?? state.actions.get(actionKey))
        : undefined;
      const outcome = asString(data.outcome);
      if (span && actionKey) {
        if (outcome) span.setAttribute("eveland.eve.task.status", outcome);
        if (outcome === "failed") setErrorStatus(span, data);
        span.end();
        state.subagents.delete(actionKey);
        state.actions.delete(actionKey);
        state.taskCalls.delete(actionKey);
      }
      return span ?? turnSpan;
    }
    case "context.settled": {
      // Eve replaced the visible history with a summary the stream never
      // exposes, so the reconstruction drops what the model can no longer see.
      if (
        turnKey &&
        asString(data.kind) === "compaction" &&
        asString(data.outcome) === "completed"
      ) {
        state.transcripts.set(turnKey, [compactionMessage()]);
      }
      return turnSpan;
    }
    case "turn.settled": {
      if (!turnKey || !turnId) return undefined;
      endTurnChildren(state, sessionId, turnId);
      forgetTurnRuns(state, sessionId, turnKey);
      const span = state.turns.get(turnKey);
      if (span) {
        const outcome = asString(data.outcome);
        if (outcome === "failed") {
          setErrorStatus(span, data);
          metrics.agentFailures.add(1, {
            [ATTR_GEN_AI_AGENT_NAME]: asString(context.agent?.name) ?? "agent",
            [ATTR_ERROR_TYPE]: asString(asRecord(data.error)?.code) ?? "unknown",
          });
        }
        if (outcome === "cancelled") span.setAttribute("eveland.turn.cancelled", true);
        span.end();
        state.turns.delete(turnKey);
        state.turnStartedAt.delete(turnKey);
      }
      return span;
    }
    case "session.ended": {
      const prefix = `${sessionId}\0`;
      for (const key of [...state.settledRuns.keys(), ...state.runModels.keys()]) {
        if (key.startsWith(prefix)) {
          state.settledRuns.delete(key);
          state.runModels.delete(key);
        }
      }
      for (const key of state.runTurns.keys()) {
        if (key.startsWith(prefix)) state.runTurns.delete(key);
      }
      endSessionSpans(state, sessionId, asString(data.outcome) === "failed", data);
      state.sessionModels.delete(sessionId);
      return undefined;
    }
    default:
      return runSpan ?? turnSpan;
  }
}

/** Ends every run of the session that settled without a following usage record. */
function endSettledRuns(state: AgentTelemetryRuntimeState, sessionId: string): void {
  const prefix = `${sessionId}\0`;
  for (const [runKey, settled] of state.settledRuns) {
    if (!runKey.startsWith(prefix)) continue;
    state.steps.get(runKey)?.end(settled.endedAt);
    state.steps.delete(runKey);
    state.stepStartedAt.delete(runKey);
    state.settledRuns.delete(runKey);
    state.runModels.delete(runKey);
  }
}

function forgetTurnRuns(
  state: AgentTelemetryRuntimeState,
  sessionId: string,
  turnKey: string,
): void {
  const runPrefix = `${turnKey}\0`;
  for (const key of [...state.settledRuns.keys(), ...state.runModels.keys()]) {
    if (key.startsWith(runPrefix)) {
      state.settledRuns.delete(key);
      state.runModels.delete(key);
    }
  }
  const turnId = turnKey.slice(sessionId.length + 1);
  for (const [key, runTurn] of state.runTurns) {
    if (key.startsWith(`${sessionId}\0`) && runTurn === turnId) state.runTurns.delete(key);
  }
}

/**
 * The key a run's span is stored under. The scope of a fact that names a run
 * by `owner.runId` (a call, a usage record) normally carries the same turn,
 * but a run owned by a context change has none, so fall back to a scan.
 */
function findRunKey(
  state: AgentTelemetryRuntimeState,
  sessionId: string,
  runId: string,
  turnId: string | undefined,
): string | undefined {
  const knownTurn = turnId ?? state.runTurns.get(spanKey(sessionId, runId));
  const direct = spanKey(sessionId, knownTurn ?? "", "run", runId);
  if (state.steps.has(direct)) return direct;
  const suffix = `\0run\0${runId}`;
  for (const key of state.steps.keys()) {
    if (key.startsWith(`${sessionId}\0`) && key.endsWith(suffix)) return key;
  }
  return undefined;
}

/** An assistant message of the turn's own, for a part no model run wrote. */
function turnAssistantFor(state: AgentTelemetryRuntimeState, turnKey: string): TranscriptMessage {
  const message: TranscriptMessage = { role: "assistant", parts: [] };
  transcriptFor(state, turnKey).push(message);
  return message;
}

function textOfParts(parts: unknown): string | undefined {
  if (!Array.isArray(parts)) return undefined;
  const texts = parts.flatMap((part) => {
    const record = asRecord(part);
    const text = asString(record?.text);
    return record?.kind === "text" && text ? [text] : [];
  });
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function contentText(data: Record<string, unknown>): string | undefined {
  if (typeof data.value === "string") return data.value.length > 0 ? data.value : undefined;
  if (data.value !== undefined && data.value !== null) return JSON.stringify(data.value);
  return asString(data.fallbackText);
}
