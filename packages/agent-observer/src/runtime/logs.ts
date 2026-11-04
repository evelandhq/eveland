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

/**
 * The session-event vocabulary the observer exports (the v27 protocol):
 * `delivery.consumed` is the received message, `content.completed` the
 * produced text (and, under `recordOutputs`, reasoning), `call.*` the actions,
 * `model.*` the model runs, `usage.recorded` the provider usage,
 * `interaction.*` the questions, approvals, and sign-ins, `context.*`
 * compaction, and the settled events carry their outcome. Progress records
 * (`content.delta`, `call.input`, `call.progress`) never reach a `*` hook.
 */
const collectedEventTypes = new Set([
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

/**
 * Whether the observer exports an event. Reasoning is `content.completed` with
 * `kind: "reasoning"`, so the kind decides.
 */
export function shouldCollectAgentTelemetryEvent(
  eventType: string,
  data: Record<string, unknown> | undefined,
  recordOutputs: boolean,
): boolean {
  if (!collectedEventTypes.has(eventType)) return false;
  if (eventType === "content.completed" && asString(data?.kind) === "reasoning") {
    return recordOutputs;
  }
  return true;
}

/** Where an event sits on its session stream, from the hook context. */
export function streamPosition(
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
  const position = streamPosition(input.context);
  const eventData = asRecord(input.event.data);
  const scope = asRecord(input.event.scope);
  // A hook event carries no timestamp of its own; eve hands the record time
  // to the hook as `ctx.now`. The log body is the envelope the collector reads
  // (`type`, `scope`, `data`, `meta.at`), plus the stream position.
  const at = asDate(input.context.now);
  const event = {
    type: input.event.type,
    ...(input.event.scope !== undefined ? { scope: input.event.scope } : {}),
    data: input.event.data,
    meta: {
      ...(at ? { at: at.toISOString() } : {}),
      ...(position ? { position } : {}),
    },
  };
  const body = sanitizeForPolicy(event, input.policy.capture, input.eventType);
  const parentSessionId = asString(input.context.session?.parent?.sessionId);
  const runId = asString(eventData?.runId) ?? asString(scope?.runId);
  const attributes: Attributes = commonAttributes(
    input.sessionId,
    asString(scope?.turnId) ?? asString(eventData?.turnId),
    input.context,
    {
      "event.name": `eve.${input.eventType}`,
      "eveland.eve.event.type": input.eventType,
      "eveland.event.id": randomUUID(),
      // A stream position never changes and is unique within the session, so
      // it dedupes a redelivered event exactly; an event eve handed over
      // without one hashes what it reports instead.
      "eveland.event.fingerprint": createHash("sha256")
        .update(input.sessionId)
        .update("\0")
        .update(position ? `position:${position.line}:${position.index}` : canonicalJson(body))
        .digest("hex"),
      ...(parentSessionId ? { "eveland.eve.parent_session.id": parentSessionId } : {}),
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
  const eventDate = at;
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
  if (eventType === "delivery.consumed") return keyName === "parts" || keyName === "history";
  if (eventType === "call.requested") return keyName === "input" || keyName === "inputRef";
  if (eventType === "interaction.opened") return keyName === "request" || keyName === "origin";
  if (eventType === "interaction.settled") return keyName === "response";
  return keyName === "clientContext";
}

function isOutputKey(eventType: string, keyName: string): boolean {
  if (isReasoningKey(keyName)) return true;
  // Produced text, reasoning, and results are all content.
  if (eventType === "content.completed") {
    return keyName === "value" || keyName === "valueRef" || keyName === "fallbackText";
  }
  if (eventType === "call.settled") return keyName === "output" || keyName === "outputRef";
  if (eventType === "turn.settled") return keyName === "reply";
  return false;
}

function isReasoningKey(keyName: string): boolean {
  return keyName === "reasoning" || keyName === "reasoningDelta" || keyName === "reasoningSoFar";
}

function severityForEvent(
  eventType: string,
  data: Record<string, unknown> | undefined,
): SeverityNumber {
  // A settled event reports how its item ended in `outcome`.
  const outcome = asString(data?.outcome);
  if (eventType.endsWith(".failed") || outcome === "failed") return SeverityNumber.ERROR;
  if (eventType.endsWith(".cancelled") || outcome === "cancelled") return SeverityNumber.WARN;
  return SeverityNumber.INFO;
}
