// Through the package's own export: the Dashboard bundles this module from source, and
// its bundler does not map a relative `.js` specifier onto the `.ts` file.
import { isDelegatedUsageRecord } from "@evelandhq/core/eve";

export type TranscriptSourceEvent = {
  type: string;
  payload: unknown;
  eventAt: string;
  sessionNodeId?: string | null;
};

export type TranscriptSourceNode = {
  id: string;
  /** The node's Eve session, matched against the `child.opened` that opened it. */
  eveSessionId?: string | null;
  parentNodeId: string | null;
  nodeId: string | null;
  agentId: string | null;
  agentName: string | null;
  status?: string | null;
  resolutionStatus?: string | null;
  remoteUrl?: string | null;
};

export type TranscriptUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type TranscriptToolCall = {
  callId: string | null;
  name: string;
  isSubagent: boolean;
  input: unknown;
  output: unknown;
  status: "completed" | "failed" | "cancelled" | "pending";
  errorText: string | null;
  usage: TranscriptUsage | null;
  /** The Eve session the call's `child.opened` says it opened. */
  childEveSessionId: string | null;
  eventAt: string;
  child: TranscriptNode | null;
};

export type TranscriptItem =
  | { kind: "user"; text: string; eventAt: string }
  | { kind: "assistant"; text: string; eventAt: string }
  | { kind: "reasoning"; text: string; eventAt: string }
  | { kind: "tool"; call: TranscriptToolCall }
  | { kind: "system"; label: string; text: string | null; eventAt: string };

export type TranscriptActivityItem = Extract<
  TranscriptItem,
  { kind: "reasoning" | "tool" | "system" }
>;

export type TranscriptDisplayItem =
  | Extract<TranscriptItem, { kind: "user" | "assistant" }>
  | {
      kind: "activity";
      status: "completed" | "failed" | "cancelled" | "running";
      items: TranscriptActivityItem[];
    };

export type TranscriptTurn = {
  turnId: string | null;
  startedAt: string;
  items: TranscriptItem[];
  userMessage: string | null;
  assistantMessage: string | null;
  status: "completed" | "failed" | "cancelled" | "incomplete";
  usage: TranscriptUsage | null;
};

export type TranscriptNode = {
  sessionNodeId: string | null;
  agentId: string | null;
  agentName: string | null;
  nodeId: string | null;
  status: string | null;
  resolutionStatus: string | null;
  remoteUrl: string | null;
  turns: TranscriptTurn[];
};

export type SessionTranscript = {
  root: TranscriptNode | null;
  detached: TranscriptNode[];
};

export function buildSessionTranscript(
  events: TranscriptSourceEvent[],
  nodes: TranscriptSourceNode[],
): SessionTranscript {
  const rootNode = nodes.find((node) => node.parentNodeId === null) ?? null;
  const views = new Map<string, TranscriptNode>();

  for (const node of nodes) {
    const nodeEvents =
      rootNode && node.id === rootNode.id
        ? events.filter(
            (event) => (event.sessionNodeId ?? null) === node.id || event.sessionNodeId == null,
          )
        : events.filter((event) => (event.sessionNodeId ?? null) === node.id);
    views.set(node.id, {
      sessionNodeId: node.id,
      agentId: node.agentId,
      agentName: node.agentName,
      nodeId: node.nodeId,
      status: node.status ?? null,
      resolutionStatus: node.resolutionStatus ?? null,
      remoteUrl: node.remoteUrl ?? null,
      turns: buildTranscriptTurns(nodeEvents),
    });
  }

  let root = rootNode ? (views.get(rootNode.id) ?? null) : null;
  if (!root && nodes.length === 0 && events.length > 0) {
    root = {
      sessionNodeId: null,
      agentId: null,
      agentName: null,
      nodeId: null,
      status: null,
      resolutionStatus: null,
      remoteUrl: null,
      turns: buildTranscriptTurns(events),
    };
  }

  const detached: TranscriptNode[] = [];
  for (const node of nodes) {
    if (rootNode && node.id === rootNode.id) continue;
    const view = views.get(node.id);
    if (!view) continue;
    const parentView = node.parentNodeId ? views.get(node.parentNodeId) : null;
    const slot = parentView ? findCallThatOpened(parentView, node.eveSessionId ?? null) : null;
    if (slot) {
      slot.child = view;
    } else {
      detached.push(view);
    }
  }

  return { root, detached };
}

export function buildTranscriptTurns(events: TranscriptSourceEvent[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  const turnsById = new Map<string, TranscriptTurn>();
  const callsById = new Map<string, TranscriptToolCall>();
  // Eve settles an interaction without repeating its kind.
  const interactionKinds = new Map<string, string>();

  const turnFor = (payload: Record<string, unknown> | null, eventAt: string): TranscriptTurn => {
    const turnId = asString(payload?.turnId);
    const existing = turnId ? turnsById.get(turnId) : turns.at(-1);
    if (existing) return existing;
    const turn: TranscriptTurn = {
      turnId,
      startedAt: eventAt,
      items: [],
      userMessage: null,
      assistantMessage: null,
      status: "incomplete",
      usage: null,
    };
    turns.push(turn);
    if (turnId) turnsById.set(turnId, turn);
    return turn;
  };

  for (const event of events) {
    const payload = asRecord(event.payload);
    switch (event.type) {
      // The stored payload is the fact's `data`; the projection copies the
      // owning turn from the envelope's scope into it when the data does not
      // name one.
      case "delivery.consumed": {
        const text = messageText(payload);
        const turn = turnFor(payload, event.eventAt);
        turn.items.push({ kind: "user", text, eventAt: event.eventAt });
        turn.userMessage ??= text;
        break;
      }
      case "content.completed": {
        const kind = asString(payload?.kind);
        const text = contentText(payload);
        if (!text) break;
        const turn = turnFor(payload, event.eventAt);
        if (kind === "reasoning") {
          turn.items.push({ kind: "reasoning", text, eventAt: event.eventAt });
        } else if (kind === "text" || kind === "result") {
          turn.items.push({ kind: "assistant", text, eventAt: event.eventAt });
          turn.assistantMessage = text;
        }
        break;
      }
      case "call.requested": {
        const capability = asRecord(payload?.capability);
        const capabilityKind = asString(capability?.kind);
        // Task controls (`eve__task_wait` and friends) are plumbing.
        if (capabilityKind === "control") break;
        const call: TranscriptToolCall = {
          callId: asString(payload?.callId),
          name: asString(capability?.name) ?? capabilityKind ?? "tool",
          isSubagent: capabilityKind === "agent",
          input: payload && "input" in payload ? payload.input : null,
          output: null,
          status: "pending",
          errorText: null,
          usage: null,
          childEveSessionId: null,
          eventAt: event.eventAt,
          child: null,
        };
        if (call.callId) callsById.set(call.callId, call);
        turnFor(payload, event.eventAt).items.push({ kind: "tool", call });
        break;
      }
      case "call.settled": {
        const callId = asString(payload?.callId);
        const call = callId ? callsById.get(callId) : undefined;
        if (!call) break;
        const outcome = asString(payload?.outcome);
        call.status =
          outcome === "completed"
            ? "completed"
            : outcome === "interrupted" || outcome === "abandoned"
              ? "cancelled"
              : "failed";
        call.output = payload && "output" in payload ? payload.output : null;
        call.errorText =
          call.status === "completed"
            ? null
            : (errorMessage(payload) ?? asString(payload?.reason) ?? outcome);
        break;
      }
      case "child.opened": {
        const owner = asRecord(payload?.owner);
        const callId = asString(owner?.callId);
        const call = callId ? callsById.get(callId) : undefined;
        if (call) {
          call.isSubagent = true;
          call.childEveSessionId = asString(payload?.sessionId);
        }
        break;
      }
      case "usage.recorded": {
        // A re-reported child spend is shown on that child's node.
        if (isDelegatedUsageRecord(payload)) break;
        const usage = usageFrom(payload?.usage);
        if (usage) {
          const turn = turnFor(payload, event.eventAt);
          turn.usage = addUsage(turn.usage, usage);
        }
        break;
      }
      case "model.settled": {
        if (asString(payload?.outcome) !== "failed") break;
        turnFor(payload, event.eventAt).items.push({
          kind: "system",
          label: "Step failed",
          text: errorMessage(payload),
          eventAt: event.eventAt,
        });
        break;
      }
      case "turn.settled": {
        const turn = turnFor(payload, event.eventAt);
        const outcome = asString(payload?.outcome);
        if (outcome === "completed") {
          turn.status = "completed";
        } else if (outcome === "failed") {
          turn.status = "failed";
          turn.items.push({
            kind: "system",
            label: "Turn failed",
            text: errorMessage(payload),
            eventAt: event.eventAt,
          });
        } else if (outcome === "cancelled") {
          turn.status = "cancelled";
          for (const call of turnToolCalls(turn)) {
            if (call.status === "pending") {
              call.status = "cancelled";
              call.errorText = "Turn cancelled";
            }
          }
          turn.items.push({
            kind: "system",
            label: "Turn cancelled",
            text: null,
            eventAt: event.eventAt,
          });
        }
        break;
      }
      case "session.ended": {
        if (asString(payload?.outcome) !== "failed") break;
        const turn = turnFor(payload, event.eventAt);
        turn.items.push({
          kind: "system",
          label: "Session failed",
          text: errorMessage(payload),
          eventAt: event.eventAt,
        });
        if (turn.status === "incomplete") turn.status = "failed";
        break;
      }
      case "interaction.opened": {
        const request = asRecord(payload?.request);
        const kind = asString(request?.kind) ?? "question";
        const interactionId = asString(payload?.interactionId);
        if (interactionId) interactionKinds.set(interactionId, kind);
        const signIn = asRecord(request?.signIn);
        turnFor(payload, event.eventAt).items.push(
          kind === "sign-in"
            ? {
                kind: "system",
                label: "Authorization required",
                text:
                  asString(signIn?.displayName) ??
                  asString(signIn?.name) ??
                  asString(request?.prompt),
                eventAt: event.eventAt,
              }
            : {
                kind: "system",
                label: "Input requested",
                text: asString(request?.prompt),
                eventAt: event.eventAt,
              },
        );
        break;
      }
      case "interaction.settled": {
        const interactionId = asString(payload?.interactionId);
        if (!interactionId || interactionKinds.get(interactionId) !== "sign-in") break;
        turnFor(payload, event.eventAt).items.push({
          kind: "system",
          label: "Authorization completed",
          text: asString(payload?.outcome),
          eventAt: event.eventAt,
        });
        break;
      }
      default:
        break;
    }
  }

  return turns;
}

/** The text of a `content.completed`: its value, or the fallback a file carries. */
function contentText(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  if (typeof payload.value === "string") return payload.value || null;
  if (payload.value !== undefined && payload.value !== null) return JSON.stringify(payload.value);
  return asString(payload.fallbackText);
}

export function groupTranscriptItems(turn: TranscriptTurn): TranscriptDisplayItem[] {
  const displayItems: TranscriptDisplayItem[] = [];
  let activityItems: TranscriptActivityItem[] = [];

  const flushActivity = (trailing = false) => {
    if (activityItems.length === 0) return;
    displayItems.push({
      kind: "activity",
      status: activityStatus(activityItems, turn.status, trailing),
      items: activityItems,
    });
    activityItems = [];
  };

  for (const item of turn.items) {
    if (item.kind === "user" || item.kind === "assistant") {
      flushActivity();
      displayItems.push(item);
    } else {
      activityItems.push(item);
    }
  }
  flushActivity(true);

  return displayItems;
}

function activityStatus(
  items: TranscriptActivityItem[],
  turnStatus: TranscriptTurn["status"],
  trailing: boolean,
): Extract<TranscriptDisplayItem, { kind: "activity" }>["status"] {
  if (
    items.some(
      (item) =>
        (item.kind === "tool" && item.call.status === "failed") ||
        (item.kind === "system" && item.label.toLowerCase().includes("failed")),
    )
  ) {
    return "failed";
  }
  if (
    items.some(
      (item) =>
        (item.kind === "tool" && item.call.status === "cancelled") ||
        (item.kind === "system" && item.label.toLowerCase().includes("cancelled")),
    )
  ) {
    return "cancelled";
  }
  if (items.some((item) => item.kind === "tool" && item.call.status === "pending")) {
    return "running";
  }
  if (turnStatus === "incomplete" && trailing) {
    return "running";
  }
  return "completed";
}

export function turnToolCalls(turn: TranscriptTurn): TranscriptToolCall[] {
  return turn.items.flatMap((item) => (item.kind === "tool" ? [item.call] : []));
}

function findCallThatOpened(
  view: TranscriptNode,
  eveSessionId: string | null,
): TranscriptToolCall | null {
  if (eveSessionId === null) return null;
  return (
    view.turns
      .flatMap(turnToolCalls)
      .find((call) => call.child === null && call.childEveSessionId === eveSessionId) ?? null
  );
}

/** The text parts of a delivery, joined. */
function messageText(payload: Record<string, unknown> | null): string {
  if (!Array.isArray(payload?.parts)) return "";
  return payload.parts
    .map((part) => asString(asRecord(part)?.text))
    .filter((text): text is string => text !== null)
    .join("");
}

/** The message of a settled item's error (`error: { code, message }`), or its reason. */
function errorMessage(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  return asString(asRecord(payload.error)?.message) ?? asString(payload.reason);
}

function usageFrom(value: unknown): TranscriptUsage | null {
  const usage = asRecord(value);
  if (!usage) return null;
  return {
    inputTokens: asNumber(usage.inputTokens),
    outputTokens: asNumber(usage.outputTokens),
    cacheReadTokens: asNumber(usage.cacheReadTokens),
    cacheWriteTokens: asNumber(usage.cacheWriteTokens),
  };
}

function addUsage(base: TranscriptUsage | null, extra: TranscriptUsage): TranscriptUsage {
  if (!base) return extra;
  return {
    inputTokens: base.inputTokens + extra.inputTokens,
    outputTokens: base.outputTokens + extra.outputTokens,
    cacheReadTokens: base.cacheReadTokens + extra.cacheReadTokens,
    cacheWriteTokens: base.cacheWriteTokens + extra.cacheWriteTokens,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
