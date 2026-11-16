import type { TranscriptUsage } from "@evelandhq/core/transcript";
import type { SessionEvent, SessionNode } from "./api";

export type TraceRole = "user" | "assistant" | "reasoning" | "tool" | "lifecycle";

export type TraceRowStatus = "completed" | "failed" | "cancelled" | "pending";

export type TraceRow = {
  /** Stable row key; the source event id plus an action suffix when one event yields several rows. */
  id: string;
  eventId: string;
  role: TraceRole;
  /** Raw event type, e.g. "delivery.consumed" or "call.requested". */
  type: string;
  /** 1-based turn ordinal across the whole session; null before the first turn. */
  turn: number | null;
  /** 1-based ordinal within the turn. */
  step: number;
  /** 0 for the root node, +1 per subagent level. */
  depth: number;
  /** Label of the owning subagent node; null for root rows. */
  agentName: string | null;
  /** Tool name for tool rows. */
  name: string | null;
  status: TraceRowStatus | null;
  /** Tool input, message text, or the raw event payload. */
  payload: unknown;
  /** Tool output; null for non-tool rows. */
  result: unknown;
  errorText: string | null;
  eventAt: string;
  /** For tool rows: when the matching call.settled arrived. */
  endAt: string | null;
  durationMs: number | null;
  usage: TranscriptUsage | null;
};

export type SessionTrace = {
  rows: TraceRow[];
  turnCount: number;
  startedAt: string | null;
  endedAt: string | null;
};

type NodeInfo = { depth: number; agentName: string | null };

export function buildSessionTrace(
  events: readonly SessionEvent[],
  nodes: readonly SessionNode[],
): SessionTrace {
  const nodeInfo = buildNodeInfo(nodes);
  const rootNodeId = nodes.find((node) => node.parentNodeId === null)?.id ?? null;

  const rows: TraceRow[] = [];
  const turnOrdinals = new Map<string, number>();
  const callRows = new Map<string, TraceRow>();
  const stepCounters = new Map<string, number>();
  let latestTurn: number | null = null;

  const turnOf = (payload: Record<string, unknown> | null): number | null => {
    const turnId = asString(payload?.turnId);
    if (turnId) {
      let ordinal = turnOrdinals.get(turnId);
      if (ordinal === undefined) {
        ordinal = turnOrdinals.size + 1;
        turnOrdinals.set(turnId, ordinal);
      }
      latestTurn = Math.max(latestTurn ?? 0, ordinal);
      return ordinal;
    }
    return latestTurn;
  };

  const nextStep = (turn: number | null): number => {
    const key = turn === null ? "pre" : String(turn);
    const step = (stepCounters.get(key) ?? 0) + 1;
    stepCounters.set(key, step);
    return step;
  };

  const push = (event: SessionEvent, row: Omit<TraceRow, "eventId" | "eventAt" | "step">) => {
    const full: TraceRow = {
      ...row,
      eventId: event.id,
      eventAt: event.eventAt,
      step: nextStep(row.turn),
    };
    rows.push(full);
    return full;
  };

  for (const event of events) {
    const payload = asRecord(event.payload);
    const info = infoFor(event, nodeInfo, rootNodeId);
    const base = {
      depth: info.depth,
      agentName: info.agentName,
      name: null,
      result: null,
      errorText: null,
      endAt: null,
      durationMs: null,
      usage: null,
    };

    switch (event.type) {
      // The stored payload is the fact's data, with its owning turn copied in.
      case "delivery.consumed": {
        push(event, {
          ...base,
          id: event.id,
          role: "user",
          type: event.type,
          turn: turnOf(payload),
          status: null,
          payload: messageText(payload) || event.payload,
        });
        break;
      }
      case "content.completed": {
        const kind = asString(payload?.kind);
        if (kind !== "text" && kind !== "result" && kind !== "reasoning") break;
        const text = contentText(payload);
        if (!text) break;
        push(event, {
          ...base,
          id: event.id,
          role: kind === "reasoning" ? "reasoning" : "assistant",
          type: event.type,
          turn: turnOf(payload),
          status: null,
          payload: text,
        });
        break;
      }
      case "call.requested": {
        const capability = asRecord(payload?.capability);
        if (asString(capability?.kind) === "control") break;
        const callId = asString(payload?.callId);
        const row = push(event, {
          ...base,
          id: event.id,
          role: "tool",
          type: event.type,
          turn: turnOf(payload),
          name: asString(capability?.name) ?? asString(capability?.kind) ?? "tool",
          status: "pending",
          payload: payload && "input" in payload ? payload.input : null,
        });
        if (callId) callRows.set(callId, row);
        break;
      }
      case "call.settled": {
        const callId = asString(payload?.callId);
        const open = callId ? callRows.get(callId) : undefined;
        if (!open || !callId) break;
        const outcome = asString(payload?.outcome);
        open.result = payload && "output" in payload ? payload.output : null;
        open.status =
          outcome === "completed"
            ? "completed"
            : outcome === "interrupted" || outcome === "abandoned"
              ? "cancelled"
              : "failed";
        open.errorText =
          open.status === "completed"
            ? null
            : (errorMessage(payload) ?? asString(payload?.reason) ?? outcome);
        open.endAt = event.eventAt;
        open.durationMs = durationBetween(open.eventAt, event.eventAt);
        callRows.delete(callId);
        break;
      }
      case "usage.recorded": {
        push(event, {
          ...base,
          id: event.id,
          role: "lifecycle",
          type: event.type,
          turn: turnOf(payload),
          status: null,
          payload: event.payload,
          usage: usageFrom(payload?.usage),
        });
        break;
      }
      case "turn.settled": {
        const turn = turnOf(payload);
        const outcome = asString(payload?.outcome);
        if (outcome === "cancelled") {
          for (const open of callRows.values()) {
            if (open.turn === turn && open.status === "pending") {
              open.status = "cancelled";
              open.errorText = "Turn cancelled";
            }
          }
        }
        push(event, {
          ...base,
          id: event.id,
          role: "lifecycle",
          type: event.type,
          turn,
          status: outcome === "failed" ? "failed" : outcome === "cancelled" ? "cancelled" : null,
          payload: event.payload,
          errorText: outcome === "failed" ? errorMessage(payload) : null,
        });
        break;
      }
      default: {
        // A settled item names its failure in its outcome.
        const failed = payload?.outcome === "failed";
        push(event, {
          ...base,
          id: event.id,
          role: "lifecycle",
          type: event.type,
          turn: turnOf(payload),
          status: failed ? "failed" : null,
          payload: event.payload,
          errorText: failed ? errorMessage(payload) : null,
        });
        break;
      }
    }
  }

  return {
    rows,
    turnCount: latestTurn ?? 0,
    startedAt: events.at(0)?.eventAt ?? null,
    endedAt: events.at(-1)?.eventAt ?? null,
  };
}

export function traceRowPreview(value: unknown, maxLength = 160): string {
  const text =
    typeof value === "string"
      ? value
      : value === null || value === undefined
        ? ""
        : stringify(value);
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength - 1)}…` : singleLine;
}

export function formatTraceDuration(durationMs: number | null): string {
  if (durationMs === null || durationMs < 0) return "";
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds - minutes * 60)} s`;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function buildNodeInfo(nodes: readonly SessionNode[]): Map<string, NodeInfo> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const info = new Map<string, NodeInfo>();
  for (const node of nodes) {
    let depth = 0;
    let current = node;
    while (current.parentNodeId) {
      const parent = byId.get(current.parentNodeId);
      if (!parent) break;
      depth += 1;
      current = parent;
    }
    info.set(node.id, {
      depth,
      agentName: depth === 0 ? null : (node.agentName ?? node.agentId ?? node.nodeId ?? "subagent"),
    });
  }
  return info;
}

function infoFor(
  event: SessionEvent,
  nodeInfo: Map<string, NodeInfo>,
  rootNodeId: string | null,
): NodeInfo {
  const nodeId = event.sessionNodeId ?? rootNodeId;
  return (nodeId ? nodeInfo.get(nodeId) : undefined) ?? { depth: 0, agentName: null };
}

function durationBetween(start: string, end: string): number | null {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : null;
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

function contentText(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  if (typeof payload.value === "string") return payload.value || null;
  if (payload.value !== undefined && payload.value !== null) return stringify(payload.value);
  return asString(payload.fallbackText);
}
