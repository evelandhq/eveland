import { createHash, randomUUID } from "node:crypto";
import {
  ROOT_CONTEXT,
  trace,
  type Attributes,
  type Span,
} from "@opentelemetry/api";
import {
  SeverityNumber,
  type LogBody,
} from "@opentelemetry/api-logs";
import type { LoggerProvider } from "@opentelemetry/sdk-logs";
import type {
  AgentTelemetryEvent,
  AgentTelemetryHookContext,
  RuntimeAgentPolicy,
} from "./contracts.js";
import { commonAttributes } from "./lifecycle.js";
import {
  asDate,
  asNonNegativeInteger,
  asRecord,
  asString,
  canonicalJson,
} from "./values.js";

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
  "subagent.called",
  "subagent.started",
  "subagent.event",
  "subagent.completed",
  "step.started",
  "step.completed",
  "step.failed",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "session.waiting",
  "session.completed",
  "session.failed",
  "compaction.requested",
  "compaction.completed",
]);

export function shouldCollectAgentTelemetryEvent(
  eventType: string,
  includeReasoning: boolean,
): boolean {
  return (
    collectedEventTypes.has(eventType) ||
    (includeReasoning && eventType === "reasoning.completed")
  );
}

export function emitAgentTelemetryEventLog(input: {
  eventType: string;
  event: AgentTelemetryEvent;
  context: AgentTelemetryHookContext;
  sessionId: string;
  correlatedSpan: Span | undefined;
  logger: ReturnType<LoggerProvider["getLogger"]>;
  policy: RuntimeAgentPolicy;
}): void {
  const body = sanitizeForPolicy(
    input.event,
    input.policy.capture,
    input.eventType,
  );
  const eventData = asRecord(input.event.data);
  const parentSessionId = asString(input.context.session?.parent?.sessionId);
  const stepIndex = asNonNegativeInteger(eventData?.stepIndex);
  const attributes: Attributes = commonAttributes(
    input.sessionId,
    asString(eventData?.turnId),
    input.context,
    {
      "event.name": `eve.${input.eventType}`,
      "eveland.eve.event.type": input.eventType,
      "eveland.event.id": randomUUID(),
      "eveland.event.fingerprint": createHash("sha256")
        .update(input.sessionId)
        .update("\0")
        .update(canonicalJson(body))
        .digest("hex"),
      ...(parentSessionId
        ? { "eveland.eve.parent_session.id": parentSessionId }
        : {}),
      ...(stepIndex !== undefined
        ? { "eveland.eve.step.index": stepIndex }
        : {}),
    },
  );
  const eventDate = asDate(input.event.meta?.at);
  const severityNumber = severityForEvent(input.eventType);
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
    if (!capture.includeReasoning && isReasoningKey(keyName)) continue;
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
  if (eventType === "message.received") {
    return keyName === "message" || keyName === "parts";
  }
  if (eventType === "actions.requested") {
    return keyName === "input";
  }
  return keyName === "clientContext";
}

function isOutputKey(eventType: string, keyName: string): boolean {
  if (eventType === "message.completed") return keyName === "message";
  if (eventType === "result.completed") return keyName === "result";
  if (eventType === "action.result" || eventType === "subagent.completed") {
    return keyName === "output";
  }
  return false;
}

function isReasoningKey(keyName: string): boolean {
  return (
    keyName === "reasoning" ||
    keyName === "reasoningDelta" ||
    keyName === "reasoningSoFar"
  );
}

function severityForEvent(eventType: string): SeverityNumber {
  if (eventType.endsWith(".failed")) return SeverityNumber.ERROR;
  if (eventType.endsWith(".cancelled")) return SeverityNumber.WARN;
  return SeverityNumber.INFO;
}
