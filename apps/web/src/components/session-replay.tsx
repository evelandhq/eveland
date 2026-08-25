"use client";

import { useMemo, useState } from "react";
import { BotIcon, ChevronDownIcon, MessageCircleIcon, XCircleIcon } from "lucide-react";
import {
  buildSessionTranscript,
  groupTranscriptItems,
  type SessionTranscript,
  type TranscriptActivityItem,
  type TranscriptDisplayItem,
  type TranscriptNode,
  type TranscriptToolCall,
  type TranscriptTurn,
} from "@evelandhq/core/transcript";
import { DateTime } from "@/components/date-time";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { SessionTrace } from "@/components/session-trace";
import {
  AgentActivity,
  AgentActivityReasoning,
  AgentActivityTool,
  shortenActivityText,
  useAgentActivityAutoCollapse,
} from "@/components/agent-activity";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { SessionEvent, SessionNode } from "@/lib/api";

type SessionReplayProps = {
  events: SessionEvent[];
  nodes: SessionNode[];
};

export function SessionReplay({ events, nodes }: SessionReplayProps) {
  const [view, setView] = useState<"chat" | "trace">("chat");
  const transcript = useMemo(() => buildSessionTranscript(events, nodes), [events, nodes]);

  return (
    <section className="overflow-hidden rounded-xl border">
      <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-2.5">
        <h3 className="text-sm font-semibold">Conversation</h3>
        <div className="inline-flex rounded-lg bg-muted p-0.5">
          <button
            className={cn(
              "rounded-md px-3 py-1 text-xs font-medium transition-colors",
              view === "chat" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
            )}
            onClick={() => setView("chat")}
            type="button"
          >
            Chat
          </button>
          <button
            className={cn(
              "rounded-md px-3 py-1 text-xs font-medium transition-colors",
              view === "trace"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground",
            )}
            onClick={() => setView("trace")}
            type="button"
          >
            Trace
          </button>
        </div>
      </div>
      {view === "chat" ? (
        <ChatView transcript={transcript} />
      ) : (
        <SessionTrace events={events} nodes={nodes} />
      )}
    </section>
  );
}

function ChatView({ transcript }: { transcript: SessionTranscript }) {
  const turns = transcript.root?.turns.filter((turn) => turn.items.length > 0) ?? [];

  if (turns.length === 0 && transcript.detached.length === 0) {
    return (
      <div className="flex min-h-40 flex-col items-center justify-center gap-2 px-4 py-8 text-center text-sm text-muted-foreground">
        <MessageCircleIcon className="size-5" />
        <p>No conversation recorded for this session.</p>
        <p className="text-xs">Switch to Trace to inspect lifecycle events.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-6">
      {turns.map((turn, index) => (
        <TurnView key={turn.turnId ?? `turn-${index}`} turn={turn} />
      ))}
      {transcript.detached.length > 0 ? (
        <div className="flex flex-col gap-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Subagent sessions
          </h4>
          {transcript.detached.map((node, index) => (
            <SubagentNode key={node.sessionNodeId ?? `detached-${index}`} node={node} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TurnView({ nested = false, turn }: { nested?: boolean; turn: TranscriptTurn }) {
  const displayItems = groupTranscriptItems(turn);

  return (
    <div className={cn("flex flex-col", nested ? "gap-3" : "gap-4")}>
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <Separator className="flex-1" />
        <DateTime value={turn.startedAt} />
        {turn.status === "failed" ? (
          <span className="font-medium text-destructive">failed</span>
        ) : null}
        {turn.status === "cancelled" ? <span className="font-medium">cancelled</span> : null}
        <Separator className="flex-1" />
      </div>
      {displayItems.map((item, index) => (
        <DisplayItemView item={item} key={displayItemKey(item, index)} />
      ))}
    </div>
  );
}

function DisplayItemView({ item }: { item: TranscriptDisplayItem }) {
  if (item.kind === "user" || item.kind === "assistant") {
    if (!item.text) return null;
    return (
      <Message from={item.kind}>
        <MessageContent className="group-[.is-user]:rounded-2xl group-[.is-user]:rounded-br-sm group-[.is-user]:bg-muted group-[.is-user]:px-3.5 group-[.is-user]:py-2.5">
          <MessageResponse>{item.text}</MessageResponse>
        </MessageContent>
      </Message>
    );
  }
  return <ActivityBlock activity={item} />;
}

type ActivityGroup = Extract<TranscriptDisplayItem, { kind: "activity" }>;

function ActivityBlock({ activity }: { activity: ActivityGroup }) {
  return (
    <AgentActivity compact count={activity.items.length} status={activity.status}>
      {activity.items.map((item, index) => (
        <ActivityItemView item={item} key={activityItemKey(item, index)} />
      ))}
    </AgentActivity>
  );
}

function ActivityItemView({ item }: { item: TranscriptActivityItem }) {
  if (item.kind === "reasoning") {
    return <AgentActivityReasoning compact text={item.text} />;
  }
  if (item.kind === "tool") {
    return item.call.isSubagent ? (
      <SubagentTask call={item.call} />
    ) : (
      <ToolActivity call={item.call} />
    );
  }
  return (
    <div className="flex items-start gap-2 py-1 text-xs text-muted-foreground">
      <XCircleIcon
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          item.label.toLowerCase().includes("failed") && "text-destructive",
        )}
      />
      <p>
        <span className="font-medium text-foreground">{item.label}</span>
        {item.text ? ` — ${item.text}` : null}
      </p>
    </div>
  );
}

function ToolActivity({ call }: { call: TranscriptToolCall }) {
  return (
    <AgentActivityTool
      compact
      errorText={call.errorText ?? undefined}
      input={call.input}
      name={call.name}
      output={call.output ?? undefined}
      status={call.status}
    />
  );
}

function SubagentTask({ call }: { call: TranscriptToolCall }) {
  const node = call.child;
  const unresolved = node?.resolutionStatus === "unresolved";
  const status: ActivityGroup["status"] = unresolved
    ? "cancelled"
    : call.status === "pending"
      ? "running"
      : call.status === "failed"
        ? "failed"
        : call.status === "cancelled"
          ? "cancelled"
          : "completed";
  const [open, setOpen] = useAgentActivityAutoCollapse(status);
  const actionCount = node ? nodeActivityCount(node) : 0;
  const preview = node ? lastAssistantMessage(node) : null;
  const stateLabel = unresolved ? "unresolved" : status === "running" ? "working" : status;

  return (
    <Collapsible className="group/subagent" onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger className="flex w-full items-start gap-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:text-foreground">
        <BotIcon className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate font-medium text-foreground">
              {node?.agentName ?? node?.agentId ?? call.name}
            </span>
            <span>· {stateLabel}</span>
            {actionCount > 0 ? (
              <span>
                · {actionCount} {actionCount === 1 ? "action" : "actions"}
              </span>
            ) : null}
          </span>
          {preview ? <span className="mt-0.5 block truncate">{preview}</span> : null}
        </span>
        {status === "running" ? (
          <Spinner className="size-3.5" />
        ) : (
          <ChevronDownIcon className="mt-0.5 size-3.5 shrink-0 transition-transform group-data-[panel-open]/subagent:rotate-180" />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="ml-1.5 mt-2 border-l border-border pl-4 data-[ending-style]:animate-out data-[starting-style]:animate-in">
        {unresolved ? (
          <p className="py-2 text-xs text-muted-foreground">
            This remote subagent was not observed, so its internal activity is unavailable.
          </p>
        ) : node ? (
          <SubagentTranscript node={node} />
        ) : (
          <p className="py-2 text-xs text-muted-foreground">
            Waiting for this subagent session to be observed.
          </p>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function SubagentNode({ node }: { node: TranscriptNode }) {
  return (
    <div className="border-l border-border pl-4">
      <div className="mb-3 flex items-center gap-2 text-sm">
        <BotIcon className="size-4 text-muted-foreground" />
        <span className="font-medium">
          {node.agentName ?? node.agentId ?? node.nodeId ?? "Subagent"}
        </span>
        {node.status ? (
          <span className="text-xs text-muted-foreground">· {node.status}</span>
        ) : null}
      </div>
      <SubagentTranscript node={node} />
    </div>
  );
}

function SubagentTranscript({ node }: { node: TranscriptNode }) {
  const turns = node.turns.filter((turn) => turn.items.length > 0);

  if (turns.length === 0) {
    return (
      <p className="py-2 text-xs text-muted-foreground">
        No conversation recorded for this subagent.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {turns.map((turn, index) => (
        <TurnView key={turn.turnId ?? `turn-${index}`} nested turn={turn} />
      ))}
    </div>
  );
}

function lastAssistantMessage(node: TranscriptNode): string | null {
  for (let index = node.turns.length - 1; index >= 0; index -= 1) {
    const turn = node.turns[index]!;
    if (turn.assistantMessage) return shortenActivityText(turn.assistantMessage);
  }
  return null;
}

function nodeActivityCount(node: TranscriptNode): number {
  return node.turns.reduce(
    (total, turn) =>
      total +
      groupTranscriptItems(turn).reduce(
        (count, item) => count + (item.kind === "activity" ? item.items.length : 0),
        0,
      ),
    0,
  );
}

function displayItemKey(item: TranscriptDisplayItem, index: number): string {
  if (item.kind === "activity")
    return `activity-${index}-${item.items[0] ? activityItemKey(item.items[0], 0) : "empty"}`;
  return `${item.kind}-${item.eventAt}-${index}`;
}

function activityItemKey(item: TranscriptActivityItem, index: number): string {
  if (item.kind === "tool") return item.call.callId ?? `tool-${item.call.eventAt}-${index}`;
  return `${item.kind}-${item.eventAt}-${index}`;
}
