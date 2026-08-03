export type TranscriptSourceEvent = {
  type: string;
  payload: unknown;
  eventAt: string;
  sessionNodeId?: string | null;
};

export type TranscriptSourceNode = {
  id: string;
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
  targetNodeId: string | null;
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
    const slot = parentView ? findOpenSubagentCall(parentView, node.nodeId) : null;
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
      case "message.received": {
        const text = messageText(payload);
        const turn = turnFor(payload, event.eventAt);
        turn.items.push({ kind: "user", text, eventAt: event.eventAt });
        turn.userMessage ??= text;
        break;
      }
      case "message.completed": {
        const text = messageText(payload);
        const turn = turnFor(payload, event.eventAt);
        turn.items.push({ kind: "assistant", text, eventAt: event.eventAt });
        turn.assistantMessage = text;
        break;
      }
      case "reasoning.completed": {
        const text = messageText(payload);
        if (text) {
          turnFor(payload, event.eventAt).items.push({
            kind: "reasoning",
            text,
            eventAt: event.eventAt,
          });
        }
        break;
      }
      case "actions.requested": {
        const turn = turnFor(payload, event.eventAt);
        const actions = Array.isArray(payload?.actions) ? payload.actions : [];
        for (const raw of actions) {
          const action = asRecord(raw);
          if (!action) continue;
          const kind = asString(action.kind) ?? "";
          const call: TranscriptToolCall = {
            callId: asString(action.callId),
            name:
              asString(action.toolName) ??
              asString(action.name) ??
              asString(action.subagentName) ??
              (kind || "tool"),
            isSubagent: kind.startsWith("subagent"),
            input: "input" in action ? action.input : null,
            output: null,
            status: "pending",
            errorText: null,
            usage: null,
            targetNodeId: asString(action.nodeId),
            eventAt: event.eventAt,
            child: null,
          };
          if (call.callId) callsById.set(call.callId, call);
          turn.items.push({ kind: "tool", call });
        }
        break;
      }
      case "action.result": {
        const result = asRecord(payload?.result);
        const status = asString(payload?.status);
        const failed = status !== null && status !== "completed";
        const callId = asString(result?.callId);
        const call = callId ? callsById.get(callId) : undefined;
        const output = result && "output" in result ? result.output : null;
        const errorText = failed ? (errorMessage(result) ?? errorMessage(payload) ?? status) : null;
        if (call) {
          call.output = output;
          call.status = failed ? "failed" : "completed";
          call.errorText = errorText;
          call.usage = usageFrom(result?.usage);
        } else {
          const kind = asString(result?.kind) ?? "";
          turnFor(payload, event.eventAt).items.push({
            kind: "tool",
            call: {
              callId,
              name:
                asString(result?.toolName) ??
                asString(result?.name) ??
                asString(result?.subagentName) ??
                (kind || "tool"),
              isSubagent: kind.startsWith("subagent"),
              input: null,
              output,
              status: failed ? "failed" : "completed",
              errorText,
              usage: usageFrom(result?.usage),
              targetNodeId: null,
              eventAt: event.eventAt,
              child: null,
            },
          });
        }
        break;
      }
      case "step.completed": {
        const usage = usageFrom(payload?.usage);
        if (usage) {
          const turn = turnFor(payload, event.eventAt);
          turn.usage = addUsage(turn.usage, usage);
        }
        break;
      }
      case "turn.completed": {
        turnFor(payload, event.eventAt).status = "completed";
        break;
      }
      case "turn.failed": {
        const turn = turnFor(payload, event.eventAt);
        turn.status = "failed";
        turn.items.push({
          kind: "system",
          label: "Turn failed",
          text: errorMessage(payload),
          eventAt: event.eventAt,
        });
        break;
      }
      case "turn.cancelled": {
        const turn = turnFor(payload, event.eventAt);
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
        break;
      }
      case "step.failed": {
        turnFor(payload, event.eventAt).items.push({
          kind: "system",
          label: "Step failed",
          text: errorMessage(payload),
          eventAt: event.eventAt,
        });
        break;
      }
      case "session.failed": {
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
      case "input.requested": {
        const request = asRecord(payload?.request);
        turnFor(payload, event.eventAt).items.push({
          kind: "system",
          label: "Input requested",
          text:
            asString(request?.prompt) ??
            asString(payload?.prompt) ??
            (messageText(payload) || null),
          eventAt: event.eventAt,
        });
        break;
      }
      case "authorization.required": {
        turnFor(payload, event.eventAt).items.push({
          kind: "system",
          label: "Authorization required",
          text: asString(payload?.displayName) ?? asString(payload?.description),
          eventAt: event.eventAt,
        });
        break;
      }
      case "authorization.completed": {
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

function findOpenSubagentCall(
  view: TranscriptNode,
  nodeId: string | null,
): TranscriptToolCall | null {
  const open = view.turns
    .flatMap(turnToolCalls)
    .filter((call) => call.isSubagent && call.child === null);
  return (
    open.find((call) => nodeId !== null && call.targetNodeId === nodeId) ??
    (nodeId === null ? (open[0] ?? null) : null)
  );
}

function messageText(payload: Record<string, unknown> | null): string {
  if (!payload) return "";
  const direct = asString(payload.message) ?? asString(payload.text) ?? asString(payload.content);
  if (direct !== null) return direct;
  if (Array.isArray(payload.parts)) {
    return payload.parts
      .map((part) => asString(asRecord(part)?.text))
      .filter((text): text is string => text !== null)
      .join("");
  }
  return "";
}

function errorMessage(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  const error = payload.error;
  return (
    asString(error) ??
    asString(asRecord(error)?.message) ??
    asString(payload.reason) ??
    asString(payload.message)
  );
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
