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
  /** Parent invocation spans whose child returned a still-working task receipt. */
  backgroundSubagents: Set<string>;
  /**
   * Calls that started an Eve >= 0.69 task: their `action.result` is only the
   * receipt, so the span stays open until the call's `task.settled`.
   */
  taskCalls: Set<string>;
  /** The call an open task is serving now, keyed by {@link taskKey}. */
  taskCurrentCalls: Map<string, string>;
  /** The task behind the call that opened an agent session, keyed by that call. */
  agentTasks: Map<string, string>;
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
    backgroundSubagents: new Set(),
    taskCalls: new Set(),
    taskCurrentCalls: new Map(),
    agentTasks: new Map(),
    ...createTranscriptState(),
  };
}

export function spanKey(...parts: string[]): string {
  return parts.join("\0");
}

/** Keys a task by its session, apart from the call keys in the same maps. */
export function taskKey(sessionId: string, taskId: string): string {
  return spanKey(sessionId, "task", taskId);
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
  if (!parentSessionId || !callId) return ROOT_CONTEXT;
  const callKey = spanKey(parentSessionId, callId);
  // A child keeps naming the call that opened it. From Eve 0.69 an agent is a
  // task the parent can continue by `taskId`, so a later turn of the same
  // child belongs under the call the task is serving now. A session an
  // authored tool opens with `ctx.agent` names that tool's call.
  const task = state.agentTasks.get(callKey);
  const currentCallKey = task ? state.taskCurrentCalls.get(task) : undefined;
  return spanContext(
    state.subagents.get(callKey) ??
      (currentCallKey ? state.subagents.get(currentCallKey) : undefined) ??
      state.actions.get(callKey),
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
  state.backgroundSubagents.clear();
  state.taskCalls.clear();
  state.taskCurrentCalls.clear();
  state.agentTasks.clear();
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
  for (const [key, span] of state.actions) {
    if (!key.startsWith(sessionPrefix)) continue;
    span.end();
    state.actions.delete(key);
  }
  for (const [key, span] of state.subagents) {
    if (!key.startsWith(sessionPrefix) || state.backgroundSubagents.has(key)) continue;
    span.end();
    state.subagents.delete(key);
  }
  // A task's calls end with their turn; the task itself, and the agent
  // session it opened, outlive it until the session ends.
  deleteKeysWithPrefix(state.taskCalls, sessionPrefix);
  deleteKeysWithPrefix(state.taskCurrentCalls, sessionPrefix);
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
  for (const keys of [
    state.backgroundSubagents,
    state.taskCalls,
    state.taskCurrentCalls,
    state.agentTasks,
  ]) {
    deleteKeysWithPrefix(keys, prefix);
  }
  forgetSession(state, prefix);
}

function deleteKeysWithPrefix(keys: Set<string> | Map<string, unknown>, prefix: string): void {
  for (const key of keys.keys()) {
    if (key.startsWith(prefix)) keys.delete(key);
  }
}
