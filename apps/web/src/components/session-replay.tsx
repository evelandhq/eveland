"use client";

import { useMemo, useState } from "react";
import { BotIcon, ChevronRightIcon, MessageCircleIcon, XCircleIcon } from "lucide-react";
import {
  buildSessionTranscript,
  type SessionTranscript,
  type TranscriptItem,
  type TranscriptNode,
  type TranscriptToolCall,
  type TranscriptTurn,
} from "@evelandhq/core/transcript";
import { DateTime } from "@/components/date-time";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { SessionTrace } from "@/components/session-trace";
import {
  BashToolContent,
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
  type ToolPart,
} from "@/components/ai-elements/tool";
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
      {turn.items.map((item, index) => (
        <TranscriptItemView item={item} key={transcriptItemKey(item, index)} />
      ))}
    </div>
  );
}

function TranscriptItemView({ item }: { item: TranscriptItem }) {
  if (item.kind === "user" || item.kind === "assistant") {
    if (!item.text) return null;
    return (
      <Message from={item.kind}>
        <MessageContent>
          <MessageResponse>{item.text}</MessageResponse>
        </MessageContent>
      </Message>
    );
  }
  if (item.kind === "reasoning") {
    return (
      <Reasoning isStreaming={false}>
        <ReasoningTrigger />
        <ReasoningContent>{item.text}</ReasoningContent>
      </Reasoning>
    );
  }
  if (item.kind === "tool") {
    return item.call.isSubagent ? (
      <SubagentTask call={item.call} />
    ) : (
      <ToolCallView call={item.call} />
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

function toolPartState(status: TranscriptToolCall["status"]): ToolPart["state"] {
  switch (status) {
    case "completed":
      return "output-available";
    case "failed":
      return "output-error";
    case "cancelled":
      return "output-denied";
    case "pending":
      return "input-available";
  }
}

function ToolCallView({ call }: { call: TranscriptToolCall }) {
  return (
    <Tool>
      <ToolHeader
        state={toolPartState(call.status)}
        title={call.name}
        toolName={call.name}
        type="dynamic-tool"
      />
      <ToolContent>
        {call.name === "bash" ? (
          <BashToolContent
            errorText={call.errorText ?? undefined}
            input={call.input}
            output={call.output}
          />
        ) : (
          <>
            <ToolInput input={call.input} />
            <ToolOutput errorText={call.errorText ?? undefined} output={call.output} />
          </>
        )}
      </ToolContent>
    </Tool>
  );
}

function SubagentTask({ call }: { call: TranscriptToolCall }) {
  const node = call.child;
  const unresolved = node?.resolutionStatus === "unresolved";
  const running = !unresolved && call.status === "pending";
  const actionCount = node ? nodeActivityCount(node) : 0;
  const preview = node ? lastAssistantMessage(node) : null;
  const stateLabel = unresolved ? "unresolved" : running ? "working" : call.status;

  return (
    <Collapsible className="group" defaultOpen={running || call.status === "failed"}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 py-0.5 text-left text-muted-foreground transition-colors hover:text-foreground">
        <BotIcon className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-sm">
            <span className="truncate">{node?.agentName ?? node?.agentId ?? call.name}</span>
            <span>· {stateLabel}</span>
            {actionCount > 0 ? (
              <span>
                · {actionCount} {actionCount === 1 ? "action" : "actions"}
              </span>
            ) : null}
          </span>
          {preview ? (
            <span className="mt-0.5 block truncate text-xs">{shortenText(preview)}</span>
          ) : null}
        </span>
        {running ? (
          <Spinner className="size-3.5 shrink-0" />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-[panel-open]:rotate-90" />
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
    if (turn.assistantMessage) return turn.assistantMessage;
  }
  return null;
}

function nodeActivityCount(node: TranscriptNode): number {
  return node.turns.reduce(
    (total, turn) =>
      total +
      turn.items.reduce(
        (count, item) => count + (item.kind === "user" || item.kind === "assistant" ? 0 : 1),
        0,
      ),
    0,
  );
}

function shortenText(value: string, limit = 96): string {
  const collapsed = value.replaceAll(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

function transcriptItemKey(item: TranscriptItem, index: number): string {
  if (item.kind === "tool") return item.call.callId ?? `tool-${item.call.eventAt}-${index}`;
  return `${item.kind}-${item.eventAt}-${index}`;
}
