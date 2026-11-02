import { createHash, randomUUID } from "node:crypto";
import { ROOT_CONTEXT, trace, type Attributes, type Span } from "@opentelemetry/api";
import { SeverityNumber, type LogBody } from "@opentelemetry/api-logs";
import type { LoggerProvider } from "@opentelemetry/sdk-logs";
import type {
  AgentTelemetryEvent,
  AgentTelemetryHookContext,
  RuntimeAgentPolicy,
} from "./contracts.js";
import { commonAttributes } from "./attributes.js";
import type { ObservedModelCall } from "./model-capture.js";
import { asDate, asNonNegativeInteger, asRecord, asString, canonicalJson } from "./values.js";

const collectedEventTypes = new Set([
  "session.started",
  "turn.started",
  "message.received",
  "message.completed",
  "result.completed",
  "actions.requested",
  "action.result",
  "input.requested",
  "authorization.required",
  "authorization.completed",
  "input.resolved",
  // Eve <= 0.68 reports delegation with these; 0.69 replaced them with the
  // task events below.
  "subagent.called",
  "subagent.started",
  "subagent.event",
  "subagent.completed",
  "task.started",
  "task.settled",
  "agent.started",
  "step.started",
  "step.completed",
  "step.failed",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "turn.waiting",
  "session.waiting",
  "session.completed",
  "session.failed",
  "compaction.requested",
  "compaction.completed",
]);

/**
 * The v27 vocabulary (eve 0.84+). Every lifecycle the v26 list covers maps
 * onto these: `delivery.consumed` is the received message, `content.completed`
 * the produced text (and, under `recordOutputs`, reasoning), `call.*` the
 * actions, `model.*` the steps, `usage.recorded` the provider usage,
 * `interaction.*` the questions, approvals, and sign-ins, `context.*`
 * compaction, and the settled events carry their outcome. Progress records
 * (`content.delta`, `call.input`, `call.progress`) never reach a `*` hook.
 */
const collectedV27EventTypes = new Set([
  "session.started",
  "session.ended",
  "turn.started",
  "turn.paused",
  "turn.settled",
  "delivery.consumed",
  "delivery.settled",
  "content.completed",
  "call.requested",
  "call.started",
  "call.settled",
  "task.started",
  "task.ended",
  "child.opened",
  "interaction.opened",
  "interaction.settled",
  "model.started",
  "model.retried",
  "model.settled",
  "usage.recorded",
  "context.started",
  "context.settled",
]);

export function shouldCollectAgentTelemetryEvent(
  eventType: string,
  recordOutputs: boolean,
): boolean {
  return (
    collectedEventTypes.has(eventType) || (recordOutputs && eventType === "reasoning.completed")
  );
}

/**
 * v27 counterpart of {@link shouldCollectAgentTelemetryEvent}. Reasoning is
 * `content.completed` with `kind: "reasoning"`, so the kind decides.
 */
export function shouldCollectAgentTelemetryEventV27(
  eventType: string,
  data: Record<string, unknown> | undefined,
  recordOutputs: boolean,
): boolean {
  if (!collectedV27EventTypes.has(eventType)) return false;
  if (eventType === "content.completed" && asString(data?.kind) === "reasoning") {
    return recordOutputs;
  }
  return true;
}

/** Where a v27 event sits on its session stream, from the hook context. */
export function v27Position(
  context: AgentTelemetryHookContext,
): { line: number; index: number } | undefined {
  const line = asNonNegativeInteger(context.position?.line);
  const index = asNonNegativeInteger(context.position?.index);
  return line !== undefined && index !== undefined ? { line, index } : undefined;
}

export function emitAgentTelemetryEventLog(input: {
  eventType: string;
  event: AgentTelemetryEvent;
  context: AgentTelemetryHookContext;
  sessionId: string;
  correlatedSpan: Span | undefined;
  logger: ReturnType<LoggerProvider["getLogger"]>;
  policy: RuntimeAgentPolicy;
  observedModel?: ObservedModelCall;
}): void {
  const position = v27Position(input.context);
  const eventData = asRecord(input.event.data);
  const scope = asRecord(input.event.scope);
  // A v27 hook event carries no timestamp of its own; eve hands the record
  // time to the hook as `ctx.now`. The log body keeps the v26 envelope shape
  // the collector reads (`type`, `data`, `meta.at`), plus the v27 `scope` and
  // stream position.
  const v27At = position ? asDate(input.context.now) : undefined;
  const event = position
    ? {
        type: input.event.type,
        ...(input.event.scope !== undefined ? { scope: input.event.scope } : {}),
        data: input.event.data,
        meta: {
          ...(v27At ? { at: v27At.toISOString() } : {}),
          position,
        },
      }
    : input.event;
  const body = sanitizeForPolicy(event, input.policy.capture, input.eventType);
  const parentSessionId = asString(input.context.session?.parent?.sessionId);
  const stepIndex = asNonNegativeInteger(eventData?.stepIndex);
  const runId = asString(eventData?.runId) ?? asString(scope?.runId);
  const attributes: Attributes = commonAttributes(
    input.sessionId,
    asString(scope?.turnId) ?? asString(eventData?.turnId),
    input.context,
    {
      "event.name": `eve.${input.eventType}`,
      "eveland.eve.event.type": input.eventType,
      "eveland.event.id": randomUUID(),
      // A v27 position never changes and is unique within the session, so it
      // dedupes a redelivered event exactly; v26 has no position and hashes
      // the event it reports instead.
      "eveland.event.fingerprint": createHash("sha256")
        .update(input.sessionId)
        .update("\0")
        .update(position ? `position:${position.line}:${position.index}` : canonicalJson(body))
        .digest("hex"),
      ...(parentSessionId ? { "eveland.eve.parent_session.id": parentSessionId } : {}),
      ...(stepIndex !== undefined ? { "eveland.eve.step.index": stepIndex } : {}),
      ...(runId ? { "eveland.eve.run.id": runId } : {}),
      ...(position
        ? {
            "eveland.eve.position.line": position.line,
            "eveland.eve.position.index": position.index,
          }
        : {}),
      ...(input.observedModel
        ? { "eveland.gen_ai.observed.model": input.observedModel.modelId }
        : {}),
      ...(input.observedModel?.responseModelId
        ? { "eveland.gen_ai.observed.response_model": input.observedModel.responseModelId }
        : {}),
    },
  );
  const eventDate = v27At ?? asDate(input.event.meta?.at);
  const severityNumber = severityForEvent(input.eventType, eventData);
  input.logger.emit({
    eventName: `eve.${input.eventType}`,
    body: body as LogBody,
    attributes,
    severityNumber,
    severityText: SeverityNumber[severityNumber],
    ...(eventDate ? { timestamp: eventDate } : {}),
    context: input.correlatedSpan
      ? trace.setSpan(ROOT_CONTEXT, input.correlatedSpan)
      : ROOT_CONTEXT,
  });
}

function sanitizeForPolicy(
  value: unknown,
  capture: RuntimeAgentPolicy["capture"],
  eventType: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForPolicy(item, capture, eventType));
  }
  const record = asRecord(value);
  if (!record) return isLogValue(value) ? value : String(value);

  const nestedEventType = asString(record.type) ?? eventType;
  const result: Record<string, unknown> = {};
  for (const [keyName, child] of Object.entries(record)) {
    if (isCredentialKey(keyName)) {
      result[keyName] = "[REDACTED]";
      continue;
    }
    if (!capture.recordInputs && isInputKey(nestedEventType, keyName)) {
      continue;
    }
    if (!capture.recordOutputs && isOutputKey(nestedEventType, keyName)) {
      continue;
    }
    result[keyName] = sanitizeForPolicy(child, capture, nestedEventType);
  }
  return result;
}

function isLogValue(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value instanceof Uint8Array
  );
}

function isCredentialKey(keyName: string): boolean {
  const normalized = keyName.replace(/[-_]/g, "").toLowerCase();
  return (
    normalized === "authorization" ||
    normalized === "cookie" ||
    normalized === "password" ||
    normalized === "secret" ||
    normalized === "token" ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("accesstoken") ||
    normalized.endsWith("refreshtoken") ||
    normalized.endsWith("idtoken") ||
    normalized.endsWith("continuationtoken") ||
    normalized.endsWith("credential")
  );
}

function isInputKey(eventType: string, keyName: string): boolean {
  // v27 (eve 0.84+).
  if (eventType === "delivery.consumed") return keyName === "parts" || keyName === "history";
  if (eventType === "call.requested") return keyName === "input" || keyName === "inputRef";
  if (eventType === "interaction.opened") return keyName === "request" || keyName === "origin";
  if (eventType === "interaction.settled") return keyName === "response";
  if (eventType === "message.received") {
    return keyName === "message" || keyName === "parts";
  }
  if (eventType === "actions.requested") {
    return keyName === "input";
  }
  if (eventType === "input.requested") {
    return keyName === "requests";
  }
  if (eventType === "input.resolved") {
    return keyName === "response";
  }
  return keyName === "clientContext";
}

function isOutputKey(eventType: string, keyName: string): boolean {
  if (isReasoningKey(keyName)) return true;
  // v27 (eve 0.84+): produced text, reasoning, and results are all content.
  if (eventType === "content.completed") {
    return keyName === "value" || keyName === "valueRef" || keyName === "fallbackText";
  }
  if (eventType === "call.settled") return keyName === "output" || keyName === "outputRef";
  if (eventType === "turn.settled") return keyName === "reply";
  if (eventType === "message.completed") return keyName === "message";
  if (eventType === "result.completed") return keyName === "result";
  if (
    eventType === "action.result" ||
    eventType === "subagent.completed" ||
    eventType === "task.settled"
  ) {
    return keyName === "output";
  }
  return false;
}

function isReasoningKey(keyName: string): boolean {
  return keyName === "reasoning" || keyName === "reasoningDelta" || keyName === "reasoningSoFar";
}

function severityForEvent(
  eventType: string,
  data: Record<string, unknown> | undefined,
): SeverityNumber {
  // v27 reports how an item ended in its settled event's `outcome`.
  const outcome = asString(data?.outcome);
  if (eventType.endsWith(".failed") || outcome === "failed") return SeverityNumber.ERROR;
  if (eventType.endsWith(".cancelled") || outcome === "cancelled") return SeverityNumber.WARN;
  return SeverityNumber.INFO;
}
