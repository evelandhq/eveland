import { createHash } from "node:crypto";
import { z } from "zod";

export const observerEnvelopeV1Schema = z.object({
  schemaVersion: z.literal(1),
  observerEventId: z.string().min(1),
  eventFingerprint: z.string().min(1),
  deploymentId: z.string().min(1),
  eveSessionId: z.string().min(1),
  parentEveSessionId: z.string().min(1).nullable(),
  sourceSequence: z.number().int().nonnegative(),
  agent: z.object({
    id: z.string().nullable(),
    name: z.string().nullable(),
    nodeId: z.string().nullable(),
  }),
  channelKind: z.string().nullable(),
  eventAt: z.iso.datetime(),
  event: z.unknown(),
});

export type ObserverEnvelopeV1 = z.infer<typeof observerEnvelopeV1Schema>;

export class ObserverEnvelopeRejectedError extends Error {
  readonly code = "OBSERVER_ENVELOPE_REJECTED";

  constructor(message: string) {
    super(message);
    this.name = "ObserverEnvelopeRejectedError";
  }
}

export function isObserverEnvelopeRejectedError(error: unknown): error is ObserverEnvelopeRejectedError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "OBSERVER_ENVELOPE_REJECTED"
  );
}

const collectedEventTypes = new Set([
  "session.started",
  "turn.started",
  "message.received",
  "message.completed",
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

export function shouldCollectObserverEvent(type: string, includeReasoning = false): boolean {
  return collectedEventTypes.has(type) || (includeReasoning && type === "reasoning.completed");
}

export function createEventFingerprint(eveSessionId: string, eventAt: string, event: unknown): string {
  return createHash("sha256").update(eveSessionId).update("\0").update(eventAt).update("\0").update(canonicalJson(event)).digest("hex");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}
