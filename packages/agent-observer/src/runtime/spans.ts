import { ROOT_CONTEXT, SpanStatusCode, trace, type Context, type Span } from "@opentelemetry/api";
import type { AgentTelemetryHookContext } from "./contracts.js";
import {
  clearTranscriptState,
  createTranscriptState,
  forgetSession,
  forgetSessionActions,
  forgetTurn,
  type TranscriptState,
} from "./messages.js";
import { asRecord, asString } from "./values.js";

/** Open spans and their start times, keyed by {@link spanKey}. */
export type AgentSpanState = {
  sessionModels: Map<string, string>;
  turns: Map<string, Span>;
  turnStartedAt: Map<string, number>;
  steps: Map<string, Span>;
  stepStartedAt: Map<string, number>;
  actions: Map<string, Span>;
  subagents: Map<string, Span>;
};

export type AgentTelemetryRuntimeState = AgentSpanState & TranscriptState;

export function createAgentTelemetryRuntimeState(): AgentTelemetryRuntimeState {
  return {
    sessionModels: new Map(),
    turns: new Map(),
    turnStartedAt: new Map(),
    steps: new Map(),
    stepStartedAt: new Map(),
    actions: new Map(),
    subagents: new Map(),
    ...createTranscriptState(),
  };
}

export function spanKey(...parts: string[]): string {
  return parts.join("\0");
}

export function spanContext(span: Span | undefined): Context {
  return span ? trace.setSpan(ROOT_CONTEXT, span) : ROOT_CONTEXT;
}

export function parentContext(
  context: AgentTelemetryHookContext,
  state: AgentTelemetryRuntimeState,
): Context {
  const parentSessionId = asString(context.session?.parent?.sessionId);
  const callId = asString(context.session?.parent?.callId);
  return spanContext(
    parentSessionId && callId ? state.subagents.get(spanKey(parentSessionId, callId)) : undefined,
  );
}

export function setErrorStatus(span: Span, data: Record<string, unknown>): void {
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

export function endAllAgentTelemetrySpans(state: AgentTelemetryRuntimeState): void {
  for (const spans of [state.steps, state.actions, state.subagents, state.turns]) {
    for (const span of spans.values()) span.end();
    spans.clear();
  }
  state.stepStartedAt.clear();
  state.turnStartedAt.clear();
  clearTranscriptState(state);
}

export function endTurnChildren(
  state: AgentTelemetryRuntimeState,
  sessionId: string,
  turnId: string,
): void {
  const turnKey = spanKey(sessionId, turnId);
  for (const stepKey of state.steps.keys()) {
    if (!stepKey.startsWith(`${turnKey}\0`)) continue;
    state.steps.get(stepKey)?.end();
    state.steps.delete(stepKey);
    state.stepStartedAt.delete(stepKey);
  }
  forgetTurn(state, turnKey);
  const sessionPrefix = `${sessionId}\0`;
  for (const spans of [state.actions, state.subagents]) {
    for (const [key, span] of spans) {
      if (!key.startsWith(sessionPrefix)) continue;
      span.end();
      spans.delete(key);
    }
  }
  forgetSessionActions(state, sessionPrefix);
}

export function endSessionSpans(
  state: AgentTelemetryRuntimeState,
  sessionId: string,
  failed: boolean,
  data: Record<string, unknown>,
): void {
  const prefix = `${sessionId}\0`;
  for (const spans of [state.steps, state.actions, state.subagents, state.turns]) {
    for (const [key, span] of spans) {
      if (!key.startsWith(prefix)) continue;
      if (failed) setErrorStatus(span, data);
      span.end();
      spans.delete(key);
    }
  }
  for (const startedAt of [state.stepStartedAt, state.turnStartedAt]) {
    for (const key of startedAt.keys()) {
      if (key.startsWith(prefix)) startedAt.delete(key);
    }
  }
  forgetSession(state, prefix);
}
