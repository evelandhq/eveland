"use client"

import { useMemo, useState } from "react"
import { MessageCircleIcon } from "lucide-react"
import {
  buildSessionTranscript,
  type SessionTranscript,
  type TranscriptItem,
  type TranscriptNode,
  type TranscriptToolCall,
  type TranscriptTurn,
} from "@eveland/core/transcript"
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message"
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning"
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import type { SessionEvent, SessionNode } from "@/lib/api"

type SessionReplayProps = {
  events: SessionEvent[]
  nodes: SessionNode[]
}

export function SessionReplay({ events, nodes }: SessionReplayProps) {
  const [view, setView] = useState<"chat" | "raw">("chat")
  const transcript = useMemo(() => buildSessionTranscript(events, nodes), [events, nodes])

  return (
    <div>
      <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Conversation</h3>
        <ButtonGroup>
          <Button onClick={() => setView("chat")} size="sm" variant={view === "chat" ? "secondary" : "outline"}>
            Chat
          </Button>
          <Button onClick={() => setView("raw")} size="sm" variant={view === "raw" ? "secondary" : "outline"}>
            Raw
          </Button>
        </ButtonGroup>
      </div>
      {view === "chat" ? <ChatView transcript={transcript} /> : <RawView events={events} />}
    </div>
  )
}

function ChatView({ transcript }: { transcript: SessionTranscript }) {
  const turns = transcript.root?.turns.filter((turn) => turn.items.length > 0) ?? []

  if (turns.length === 0 && transcript.detached.length === 0) {
    return (
      <div className="flex min-h-40 flex-col items-center justify-center gap-2 px-4 py-8 text-center text-sm text-muted-foreground">
        <MessageCircleIcon className="size-5" />
        <p>No conversation recorded for this session.</p>
        <p className="text-xs">Switch to Raw to inspect lifecycle events.</p>
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-6">
      {turns.map((turn, index) => (
        <TurnView key={turn.turnId ?? `turn-${index}`} turn={turn} />
      ))}
      {transcript.detached.length > 0 ? (
        <div className="flex flex-col gap-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Subagent sessions</h4>
          {transcript.detached.map((node, index) => (
            <NodeCard key={node.sessionNodeId ?? `detached-${index}`} node={node} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function TurnView({ turn }: { turn: TranscriptTurn }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        <time>{new Date(turn.startedAt).toLocaleString()}</time>
        {turn.status === "failed" ? <span className="font-medium text-destructive">failed</span> : null}
        {turn.status === "cancelled" ? <span className="font-medium">cancelled</span> : null}
        <span className="h-px flex-1 bg-border" />
      </div>
      {turn.items.map((item, index) => (
        <ItemView item={item} key={index} />
      ))}
    </div>
  )
}

function ItemView({ item }: { item: TranscriptItem }) {
  if (item.kind === "user" || item.kind === "assistant") {
    if (!item.text) return null
    return (
      <Message from={item.kind}>
        <MessageContent>
          <MessageResponse>{item.text}</MessageResponse>
        </MessageContent>
      </Message>
    )
  }
  if (item.kind === "reasoning") {
    return (
      <Reasoning defaultOpen={false}>
        <ReasoningTrigger />
        <ReasoningContent>{item.text}</ReasoningContent>
      </Reasoning>
    )
  }
  if (item.kind === "tool") {
    return <ToolCallCard call={item.call} />
  }
  return (
    <p className="text-center text-xs text-muted-foreground">
      <span className="font-medium">{item.label}</span>
      {item.text ? ` — ${item.text}` : null}
    </p>
  )
}

const toolStates = {
  completed: "output-available",
  failed: "output-error",
  pending: "input-streaming",
} as const

function ToolCallCard({ call }: { call: TranscriptToolCall }) {
  return (
    <Tool className="mb-0">
      <ToolHeader
        state={toolStates[call.status]}
        title={call.isSubagent ? `Subagent · ${call.name}` : call.name}
        toolName={call.name}
        type="dynamic-tool"
      />
      <ToolContent>
        {call.input != null ? <ToolInput input={call.input} /> : null}
        <ToolOutput errorText={call.errorText ?? undefined} output={call.output ?? undefined} />
        {call.child ? <NodeCard node={call.child} /> : null}
      </ToolContent>
    </Tool>
  )
}

function NodeCard({ node }: { node: TranscriptNode }) {
  const turns = node.turns.filter((turn) => turn.items.length > 0)

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-4 text-xs">
        <span className="font-medium">{node.agentName ?? node.agentId ?? node.nodeId ?? "Subagent"}</span>
        {node.status ? <span className="text-muted-foreground">{node.status}</span> : null}
      </div>
      {turns.length === 0 ? (
        <p className="text-xs text-muted-foreground">No conversation recorded for this subagent.</p>
      ) : (
        turns.map((turn, index) => <TurnView key={turn.turnId ?? `turn-${index}`} turn={turn} />)
      )}
    </div>
  )
}

function RawView({ events }: { events: SessionEvent[] }) {
  if (events.length === 0) {
    return <div className="flex min-h-40 items-center justify-center px-4 py-8 text-sm text-muted-foreground">No timeline events recorded.</div>
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      {events.map((event) => (
        <article className="rounded-md border border-border bg-background p-3" key={event.id}>
          <div className="flex items-center justify-between gap-4">
            <h3 className="text-xs font-semibold uppercase tracking-normal">{event.type}</h3>
            <time className="text-xs text-muted-foreground">{new Date(event.eventAt).toLocaleString()}</time>
          </div>
          <pre className="mt-3 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-sm bg-muted p-3 text-xs leading-5">{formatPayload(event.payload)}</pre>
        </article>
      ))}
    </div>
  )
}

function formatPayload(payload: unknown): string {
  if (typeof payload === "string") {
    return payload
  }
  if (isRecord(payload)) {
    const content = payload.content
    if (typeof content === "string") {
      return content
    }
    const message = payload.message
    if (typeof message === "string") {
      return message
    }
  }
  return JSON.stringify(payload, null, 2)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
