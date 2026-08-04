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
import {
  ATTR_ERROR_TYPE,
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_CALL_RESULT,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_SESSION_ID,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
  GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
} from "@opentelemetry/semantic-conventions/incubating";
import type { AgentTelemetryHookContext, RuntimeAgentPolicy } from "./contracts.js";
import { recordUsage, type AgentTelemetryMetrics } from "./metrics.js";
import { asNonNegativeInteger, asRecord, asString, serializeAttribute } from "./values.js";

/**
 * One message part, as modelled by the GenAI semantic conventions JSON schema
 * for `gen_ai.input.messages` and `gen_ai.output.messages`
 * (open-telemetry/semantic-conventions-genai, model/gen-ai). Only the part types
 * Eve's event stream can produce are represented.
 */
type MessagePart =
  | { type: "text"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "tool_call"; id: string; name: string; arguments?: unknown }
  | { type: "tool_call_response"; id: string; response: unknown }
  | { type: "compaction"; content: null };

/**
 * One reconstructed conversation message. Eve's stream never carries the messages
 * a model call actually received, so the observer rebuilds the visible part of the
 * conversation from the events it does see; see {@link transcriptFor}.
 *
 * `finish_reason` is required on output messages and absent on input messages, so
 * the same message is serialized both ways: {@link toInputMessage} drops it and
 * {@link toOutputMessage} supplies a default.
 */
type TranscriptMessage = {
  role: "system" | "user" | "assistant" | "tool";
  parts: MessagePart[];
  /** Participant name; carries the tool name on a tool-role message. */
  name?: string;
  finish_reason?: string;
};

/**
 * Maps Eve's `AssistantStepFinishReason` onto the semantic conventions
 * FinishReason enum. Unmapped values pass through, which the schema allows.
 */
const finishReasons: Record<string, string> = {
  "content-filter": "content_filter",
  error: "error",
  length: "length",
  stop: "stop",
  "tool-calls": "tool_call",
};

/** Per-message content cap applied before the whole-transcript budget. */
const maxTranscriptMessageChars = 8_000;
/** Serialized transcript budget, below `serializeAttribute`'s hard cap so the JSON stays valid. */
const maxTranscriptChars = 48_000;

export type AgentTelemetryRuntimeState = {
  sessionModels: Map<string, string>;
  turns: Map<string, Span>;
  turnStartedAt: Map<string, number>;
  steps: Map<string, Span>;
  stepStartedAt: Map<string, number>;
  actions: Map<string, Span>;
  subagents: Map<string, Span>;
  /** Turn-scoped reconstructed conversation, keyed by turn. */
  transcripts: Map<string, TranscriptMessage[]>;
  /**
   * The assistant message a step is producing, keyed by step. Held by reference
   * so reasoning, text, and tool calls can land on it as their events arrive
   * while it already sits in the transcript in the right chat order.
   */
  stepAssistants: Map<string, TranscriptMessage>;
  /** Tool name per in-flight action, so a tool result can name itself in the transcript. */
  actionToolNames: Map<string, string>;
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
    transcripts: new Map(),
    stepAssistants: new Map(),
    actionToolNames: new Map(),
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
  const { eventType, data, sessionId, context, state, tracer, metrics, now, capture } = input;
  const turnId = asString(data.turnId);
  const stepIndex = asNonNegativeInteger(data.stepIndex);
  const turnKey = turnId ? key(sessionId, turnId) : undefined;
  const stepKey =
    turnId && stepIndex !== undefined ? key(sessionId, turnId, String(stepIndex)) : undefined;

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
          serializeAttribute([{ role: "user", parts: [{ type: "text", content: message }] }]),
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
      if (capture.recordInputs && turnKey) {
        setReconstructedInput(span, state, turnKey);
      }
      state.steps.set(stepKey, span);
      state.stepStartedAt.set(stepKey, now());
      return span;
    }
    case "actions.requested": {
      const actions = Array.isArray(data.actions) ? data.actions : [];
      // A step's tool calls belong to the model call that requested them, so the
      // spans nest under the step when it is still open and fall back to the turn
      // for actions the runtime dispatches after the step closed.
      const actionParent = spanContext(
        (stepKey ? state.steps.get(stepKey) : undefined) ??
          (turnKey ? state.turns.get(turnKey) : undefined),
      );
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
                [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
                [ATTR_GEN_AI_AGENT_NAME]: agentName,
                [ATTR_GEN_AI_TOOL_CALL_ID]: callId,
              }),
            },
            actionParent,
          );
          // A subagent invocation is an agent operation, so its input belongs in the
          // conventions' message attribute. `gen_ai.agent.input` is not a registered
          // attribute, and squatting in the `gen_ai.*` namespace left it readable only
          // to destinations configured to know the invented name.
          if (capture.recordInputs && action.input !== undefined) {
            span.setAttribute(
              ATTR_GEN_AI_INPUT_MESSAGES,
              serializeAttribute([
                { role: "user", parts: [{ type: "text", content: stringify(action.input) }] },
              ]),
            );
          }
          state.subagents.set(actionKey, span);
          state.actionToolNames.set(actionKey, agentName);
          recordToolCall(state, stepKey, turnKey, callId, agentName, action.input, capture);
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
        recordToolCall(state, stepKey, turnKey, callId, toolName, action.input, capture);
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
      const actionKey = key(sessionId, callId);
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
              serializeAttribute([subagentOutputMessage(result.output)]),
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
                role: "assistant",
                parts: [{ type: "text", content: message }],
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
      // exposes, so the reconstruction drops what the model can no longer see and
      // says so with the conventions' compaction part.
      // A step still holding an assistant message keeps it: that output really was
      // produced. Only the reconstructed history the next model call sees is reset.
      if (turnKey) {
        state.transcripts.set(turnKey, [
          { role: "system", parts: [{ type: "compaction", content: null }] },
        ]);
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
      const actionKey = key(sessionId, callId);
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
      const actionKey = callId ? key(sessionId, callId) : undefined;
      const span = actionKey ? state.subagents.get(actionKey) : undefined;
      if (span) {
        if (capture.recordOutputs && data.output !== undefined) {
          span.setAttribute(
            ATTR_GEN_AI_OUTPUT_MESSAGES,
            serializeAttribute([subagentOutputMessage(data.output)]),
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
    [ATTR_GEN_AI_CONVERSATION_ID]: sessionId,
    [ATTR_SESSION_ID]: sessionId,
    "eveland.eve.session.id": sessionId,
    ...(turnId ? { "eveland.eve.turn.id": turnId } : {}),
    ...(agentName
      ? {
          [ATTR_GEN_AI_AGENT_NAME]: agentName,
          "eveland.eve.agent.name": agentName,
        }
      : {}),
    ...(agentNodeId ? { "eveland.eve.agent.node.id": agentNodeId } : {}),
    ...(channelKind ? { "eveland.eve.channel.kind": channelKind } : {}),
  };
}

export function endAllAgentTelemetrySpans(state: AgentTelemetryRuntimeState): void {
  for (const spans of [state.steps, state.actions, state.subagents, state.turns]) {
    for (const span of spans.values()) span.end();
    spans.clear();
  }
  state.stepStartedAt.clear();
  state.turnStartedAt.clear();
  state.transcripts.clear();
  state.stepAssistants.clear();
  state.actionToolNames.clear();
}

function transcriptFor(state: AgentTelemetryRuntimeState, turnKey: string): TranscriptMessage[] {
  const existing = state.transcripts.get(turnKey);
  if (existing) return existing;
  const created: TranscriptMessage[] = [];
  state.transcripts.set(turnKey, created);
  return created;
}

/**
 * Returns the assistant message this step is building, appending it to the turn
 * transcript on first use so it sits before the tool results that answer it.
 *
 * An event that identifies no step gets a detached message: without a step key
 * there is nothing to deduplicate against, and appending one per event would
 * grow the transcript without bound.
 */
function stepAssistantFor(
  state: AgentTelemetryRuntimeState,
  stepKey: string | undefined,
  turnKey: string | undefined,
): TranscriptMessage {
  const existing = stepKey ? state.stepAssistants.get(stepKey) : undefined;
  if (existing) return existing;
  const created: TranscriptMessage = { role: "assistant", parts: [] };
  if (!stepKey) return created;
  state.stepAssistants.set(stepKey, created);
  if (turnKey) transcriptFor(state, turnKey).push(created);
  return created;
}

function recordToolCall(
  state: AgentTelemetryRuntimeState,
  stepKey: string | undefined,
  turnKey: string | undefined,
  callId: string,
  toolName: string,
  input: unknown,
  capture: RuntimeAgentPolicy["capture"],
): void {
  stepAssistantFor(state, stepKey, turnKey).parts.push({
    type: "tool_call",
    id: callId,
    name: toolName,
    ...(capture.recordInputs && input !== undefined ? { arguments: input } : {}),
  });
}

/**
 * Writes the conversation the observer could rebuild from Eve's event stream.
 *
 * Eve exposes no model request, so this is explicitly NOT the prompt the model
 * received: the system prompt, resolved instructions and tool schemas are absent,
 * it covers only the current turn, and compaction rewrites it server-side. The
 * `eveland.gen_ai.input.*` markers record each of those caveats so a reader can
 * tell a reconstruction from a real prompt.
 */
function setReconstructedInput(
  span: Span,
  state: AgentTelemetryRuntimeState,
  turnKey: string,
): void {
  const transcript = state.transcripts.get(turnKey);
  if (!transcript?.length) return;
  const { messages, elided } = budgetTranscript(transcript);
  span.setAttribute(ATTR_GEN_AI_INPUT_MESSAGES, serializeAttribute(messages.map(toInputMessage)));
  span.setAttribute("eveland.gen_ai.input.reconstructed", true);
  if (elided) span.setAttribute("eveland.gen_ai.input.elided", true);
}

/**
 * Wraps a subagent's returned value as an output message. A subagent invocation is
 * an agent operation, so the conventions' message attribute is where its result
 * belongs; `gen_ai.agent.output` is not a registered attribute.
 */
function subagentOutputMessage(output: unknown): TranscriptMessage {
  return {
    role: "assistant",
    parts: [{ type: "text", content: stringify(output) }],
    finish_reason: "stop",
  };
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Input messages carry no `finish_reason`. */
function toInputMessage(message: TranscriptMessage): Omit<TranscriptMessage, "finish_reason"> {
  const { finish_reason: _finishReason, ...input } = message;
  return input;
}

/** `finish_reason` is required on output messages. */
function toOutputMessage(message: TranscriptMessage): TranscriptMessage {
  return { ...message, finish_reason: message.finish_reason ?? "stop" };
}

function mapFinishReason(finishReason: string | undefined): string | undefined {
  if (!finishReason) return undefined;
  return finishReasons[finishReason] ?? finishReason;
}

/**
 * Keeps the serialized transcript under budget while leaving valid JSON.
 *
 * Every step carries the whole turn so far, which makes span bytes quadratic in
 * turn length; a single tool result in production has exceeded 60 KB. Oversized
 * contents are clipped first, then the oldest messages are dropped in favour of
 * an explicit marker, because the newest exchanges are the ones being debugged.
 */
function budgetTranscript(transcript: TranscriptMessage[]): {
  messages: TranscriptMessage[];
  elided: boolean;
} {
  let elided = false;
  const clipped = transcript.map((message) => {
    const parts = message.parts.map((part) => {
      const clippedPart = clipPart(part);
      if (clippedPart !== part) elided = true;
      return clippedPart;
    });
    return { ...message, parts };
  });

  const kept: TranscriptMessage[] = [];
  let total = 0;
  for (let index = clipped.length - 1; index >= 0; index -= 1) {
    const size = JSON.stringify(clipped[index]).length;
    if (kept.length > 0 && total + size > maxTranscriptChars) {
      elided = true;
      kept.unshift({
        role: "system",
        parts: [{ type: "text", content: `[${index + 1} earlier message(s) elided by Eveland]` }],
      });
      break;
    }
    total += size;
    kept.unshift(clipped[index]!);
  }
  return { messages: kept, elided };
}

/** Returns the part unchanged when it already fits, so callers can detect clipping by identity. */
function clipPart(part: MessagePart): MessagePart {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.content.length <= maxTranscriptMessageChars
        ? part
        : { ...part, content: clip(part.content) };
    case "tool_call": {
      const serialized = JSON.stringify(part.arguments ?? null);
      return serialized.length <= maxTranscriptMessageChars
        ? part
        : { ...part, arguments: clip(serialized) };
    }
    case "tool_call_response": {
      const serialized = JSON.stringify(part.response ?? null);
      return serialized.length <= maxTranscriptMessageChars
        ? part
        : { ...part, response: clip(serialized) };
    }
    default:
      return part;
  }
}

function clip(value: string): string {
  return `${value.slice(0, maxTranscriptMessageChars)}… [clipped]`;
}

function parentContext(
  context: AgentTelemetryHookContext,
  state: AgentTelemetryRuntimeState,
): Context {
  const parentSessionId = asString(context.session?.parent?.sessionId);
  const callId = asString(context.session?.parent?.callId);
  return spanContext(
    parentSessionId && callId ? state.subagents.get(key(parentSessionId, callId)) : undefined,
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
  for (const stepKey of state.stepAssistants.keys()) {
    if (stepKey.startsWith(`${prefix}\0`)) state.stepAssistants.delete(stepKey);
  }
  state.transcripts.delete(prefix);
  const sessionPrefix = `${sessionId}\0`;
  for (const spans of [state.actions, state.subagents]) {
    for (const [spanKey, span] of spans) {
      if (!spanKey.startsWith(sessionPrefix)) continue;
      span.end();
      spans.delete(spanKey);
    }
  }
  for (const actionKey of state.actionToolNames.keys()) {
    if (actionKey.startsWith(sessionPrefix)) state.actionToolNames.delete(actionKey);
  }
}

function endSessionSpans(
  state: AgentTelemetryRuntimeState,
  sessionId: string,
  failed: boolean,
  data: Record<string, unknown>,
): void {
  const prefix = `${sessionId}\0`;
  for (const spans of [state.steps, state.actions, state.subagents, state.turns]) {
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
  for (const scoped of [state.transcripts, state.stepAssistants, state.actionToolNames]) {
    for (const scopedKey of scoped.keys()) {
      if (scopedKey.startsWith(prefix)) scoped.delete(scopedKey);
    }
  }
}

function key(...parts: string[]): string {
  return parts.join("\0");
}
