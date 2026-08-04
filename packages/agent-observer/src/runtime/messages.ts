import type { Attributes } from "@opentelemetry/api";
import { ATTR_GEN_AI_INPUT_MESSAGES } from "@opentelemetry/semantic-conventions/incubating";
import { serializeAttribute } from "./values.js";

/**
 * One message part, as modelled by the GenAI semantic conventions JSON schema
 * for `gen_ai.input.messages` and `gen_ai.output.messages`
 * (open-telemetry/semantic-conventions-genai, model/gen-ai). Only the part types
 * Eve's event stream can produce are represented.
 */
export type MessagePart =
  | { type: "text"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "tool_call"; id: string; name: string; arguments?: unknown }
  | { type: "tool_call_response"; id: string; response: unknown }
  | { type: "compaction"; content: null };

/**
 * One reconstructed conversation message. Eve's stream never carries the messages
 * a model call actually received, so the observer rebuilds the visible part of the
 * conversation from the events it does see; see {@link reconstructedInputAttributes}.
 */
export type TranscriptMessage = {
  role: "system" | "user" | "assistant" | "tool";
  parts: MessagePart[];
  /** Participant name; carries the tool name on a tool-role message. */
  name?: string;
  finish_reason?: string;
};

export type TranscriptState = {
  transcripts: Map<string, TranscriptMessage[]>;
  /**
   * The assistant message a step is producing, keyed by step. Held by reference
   * so reasoning, text, and tool calls can land on it as their events arrive
   * while it already sits in the transcript in the right chat order.
   */
  stepAssistants: Map<string, TranscriptMessage>;
  actionToolNames: Map<string, string>;
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

const maxTranscriptMessageChars = 8_000;
/** Serialized transcript budget, below `serializeAttribute`'s hard cap so the JSON stays valid. */
const maxTranscriptChars = 48_000;

export function createTranscriptState(): TranscriptState {
  return {
    transcripts: new Map(),
    stepAssistants: new Map(),
    actionToolNames: new Map(),
  };
}

export function transcriptFor(state: TranscriptState, turnKey: string): TranscriptMessage[] {
  const existing = state.transcripts.get(turnKey);
  if (existing) return existing;
  const created: TranscriptMessage[] = [];
  state.transcripts.set(turnKey, created);
  return created;
}

/**
 * Returns the assistant message this step is building, appended to the turn
 * transcript on first use so it sits before the tool results that answer it.
 *
 * An event that identifies no step gets a detached message: with nothing to
 * deduplicate against, one per event would grow the transcript without bound.
 */
export function stepAssistantFor(
  state: TranscriptState,
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

export function recordToolCall(
  state: TranscriptState,
  input: {
    stepKey: string | undefined;
    turnKey: string | undefined;
    callId: string;
    toolName: string;
    arguments?: unknown;
  },
): void {
  stepAssistantFor(state, input.stepKey, input.turnKey).parts.push({
    type: "tool_call",
    id: input.callId,
    name: input.toolName,
    ...(input.arguments !== undefined ? { arguments: input.arguments } : {}),
  });
}

export function textMessage(role: TranscriptMessage["role"], content: string): TranscriptMessage {
  return { role, parts: [{ type: "text", content }] };
}

export function serializedTextMessage(
  role: TranscriptMessage["role"],
  value: unknown,
): TranscriptMessage {
  return textMessage(role, typeof value === "string" ? value : JSON.stringify(value));
}

export function compactionMessage(): TranscriptMessage {
  return { role: "system", parts: [{ type: "compaction", content: null }] };
}

/**
 * Attributes describing the conversation the observer could rebuild from Eve's
 * event stream, or `undefined` when there is nothing to report yet.
 *
 * Eve exposes no model request, so this is explicitly NOT the prompt the model
 * received: the system prompt, resolved instructions and tool schemas are absent,
 * it covers only the current turn, and compaction rewrites it server-side. The
 * `eveland.gen_ai.input.*` markers record each of those caveats so a reader can
 * tell a reconstruction from a real prompt.
 */
export function reconstructedInputAttributes(
  state: TranscriptState,
  turnKey: string,
): Attributes | undefined {
  const transcript = state.transcripts.get(turnKey);
  if (!transcript?.length) return undefined;
  const { messages, elided } = budgetTranscript(transcript);
  return {
    [ATTR_GEN_AI_INPUT_MESSAGES]: serializeAttribute(messages.map(toInputMessage)),
    "eveland.gen_ai.input.reconstructed": true,
    ...(elided ? { "eveland.gen_ai.input.elided": true } : {}),
  };
}

/** Input messages carry no `finish_reason`. */
export function toInputMessage(
  message: TranscriptMessage,
): Omit<TranscriptMessage, "finish_reason"> {
  const { finish_reason: _finishReason, ...input } = message;
  return input;
}

/** `finish_reason` is required on output messages. */
export function toOutputMessage(message: TranscriptMessage): TranscriptMessage {
  return { ...message, finish_reason: message.finish_reason ?? "stop" };
}

export function mapFinishReason(finishReason: string | undefined): string | undefined {
  if (!finishReason) return undefined;
  return finishReasons[finishReason] ?? finishReason;
}

export function forgetTurn(state: TranscriptState, turnKey: string): void {
  state.transcripts.delete(turnKey);
  for (const stepKey of state.stepAssistants.keys()) {
    if (stepKey.startsWith(`${turnKey}\0`)) state.stepAssistants.delete(stepKey);
  }
}

/**
 * Actions are keyed by session and call id rather than by turn, so a turn ending
 * can only release them at session scope.
 */
export function forgetSessionActions(state: TranscriptState, sessionPrefix: string): void {
  for (const actionKey of state.actionToolNames.keys()) {
    if (actionKey.startsWith(sessionPrefix)) state.actionToolNames.delete(actionKey);
  }
}

export function forgetSession(state: TranscriptState, sessionPrefix: string): void {
  for (const scoped of [state.transcripts, state.stepAssistants, state.actionToolNames]) {
    for (const scopedKey of scoped.keys()) {
      if (scopedKey.startsWith(sessionPrefix)) scoped.delete(scopedKey);
    }
  }
}

export function clearTranscriptState(state: TranscriptState): void {
  state.transcripts.clear();
  state.stepAssistants.clear();
  state.actionToolNames.clear();
}

/**
 * Keeps the serialized transcript under budget while leaving valid JSON.
 *
 * Every step carries the whole turn so far, which makes span bytes quadratic in
 * turn length; a single tool result in production has exceeded 60 KB. The newest
 * exchanges are the ones being debugged, so the oldest are the ones dropped.
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
      kept.unshift(textMessage("system", `[${index + 1} earlier message(s) elided by Eveland]`));
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
