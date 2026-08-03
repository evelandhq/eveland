"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  BotIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleDashedIcon,
  XCircleIcon,
} from "lucide-react";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";

export type AgentActivityStatus = "completed" | "failed" | "cancelled" | "running";
export type AgentActivityToolStatus = "completed" | "failed" | "cancelled" | "pending";

export function AgentActivity({
  children,
  count,
  status,
}: {
  children: ReactNode;
  count: number;
  status: AgentActivityStatus;
}) {
  const [open, setOpen] = useAgentActivityAutoCollapse(status);
  const title =
    status === "running"
      ? "Working"
      : status === "failed"
        ? "Work failed"
        : status === "cancelled"
          ? "Work stopped"
          : "Worked";
  const countLabel = `${count} ${count === 1 ? "action" : "actions"}`;

  return (
    <Collapsible className="group/activity" onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 py-1 text-left text-sm text-muted-foreground transition-colors hover:text-foreground">
        <AgentActivityStatusIcon status={status} />
        <span className="font-medium text-foreground">{title}</span>
        <span>· {countLabel}</span>
        <ChevronDownIcon className="ml-auto size-4 transition-transform group-data-[panel-open]/activity:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="ml-2 mt-2 flex flex-col gap-2 border-l border-border pl-4 data-[ending-style]:animate-out data-[starting-style]:animate-in">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function AgentActivityReasoning({
  isStreaming = false,
  text,
}: {
  isStreaming?: boolean;
  text: string;
}) {
  return (
    <Reasoning
      className="mb-0"
      defaultOpen={isStreaming ? undefined : false}
      isStreaming={isStreaming}
    >
      <ReasoningTrigger
        className="text-xs"
        getThinkingMessage={(streaming) => (
          <span>{streaming ? "Reasoning…" : "Reasoned through the approach"}</span>
        )}
      />
      <ReasoningContent className="mt-2 text-xs leading-relaxed">{text}</ReasoningContent>
    </Reasoning>
  );
}

export function AgentActivityTool({
  children,
  errorText,
  input,
  kind = "tool",
  name,
  openOnAttention = false,
  output,
  status,
}: {
  children?: ReactNode;
  errorText?: string;
  input: unknown;
  kind?: "tool" | "subagent";
  name: string;
  openOnAttention?: boolean;
  output?: unknown;
  status: AgentActivityToolStatus;
}) {
  const [open, setOpen] = useState(openOnAttention);
  const label =
    kind === "subagent"
      ? subagentActivityLabel(name, status)
      : agentActivityToolLabel(name, status, input);

  useEffect(() => {
    if (openOnAttention) setOpen(true);
  }, [openOnAttention]);

  return (
    <Collapsible className="group/tool" onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:text-foreground">
        <AgentActivityToolStatusIcon status={status} />
        {kind === "subagent" ? <BotIcon className="size-3.5 shrink-0" /> : null}
        <span className="truncate text-foreground">{label}</span>
        <span className="sr-only">{status}</span>
        <ChevronDownIcon className="ml-auto size-3.5 shrink-0 transition-transform group-data-[panel-open]/tool:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="ml-5 mt-2 flex flex-col gap-3 pb-2 text-xs data-[ending-style]:animate-out data-[starting-style]:animate-in [&_code]:text-xs [&_pre]:text-xs">
        {children}
        {input != null ? <ToolInput input={input} /> : null}
        <ToolOutput errorText={errorText} output={output} />
      </CollapsibleContent>
    </Collapsible>
  );
}

export function useAgentActivityAutoCollapse(status: AgentActivityStatus) {
  const [open, setOpen] = useState(status === "running" || status === "failed");
  const previousStatus = useRef(status);

  useEffect(() => {
    const previous = previousStatus.current;
    previousStatus.current = status;
    if (status === "running" || status === "failed") {
      setOpen(true);
      return;
    }
    if (previous === "running") {
      const timer = window.setTimeout(() => setOpen(false), 800);
      return () => window.clearTimeout(timer);
    }
  }, [status]);

  return [open, setOpen] as const;
}

export function shortenActivityText(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > 72 ? `${singleLine.slice(0, 69)}…` : singleLine;
}

function AgentActivityStatusIcon({ status }: { status: AgentActivityStatus }) {
  if (status === "running") return <Spinner className="size-4" />;
  if (status === "failed") return <XCircleIcon className="size-4 text-destructive" />;
  if (status === "cancelled") return <CircleDashedIcon className="size-4" />;
  return <CheckCircle2Icon className="size-4" />;
}

function AgentActivityToolStatusIcon({ status }: { status: AgentActivityToolStatus }) {
  if (status === "pending") return <Spinner className="size-3.5 shrink-0" />;
  if (status === "failed") return <XCircleIcon className="size-3.5 shrink-0 text-destructive" />;
  if (status === "cancelled") return <CircleDashedIcon className="size-3.5 shrink-0" />;
  return <CheckCircle2Icon className="size-3.5 shrink-0" />;
}

function agentActivityToolLabel(
  name: string,
  status: AgentActivityToolStatus,
  rawInput: unknown,
): string {
  const input = isRecord(rawInput) ? rawInput : null;
  const normalizedName = name.toLowerCase();
  const path = firstString(input, ["path", "filePath", "file", "filename"]);
  const query = firstString(input, ["query", "pattern", "search", "text"]);
  const command = firstString(input, ["command", "cmd"]);
  const running = status === "pending";

  if (
    normalizedName.includes("read") ||
    normalizedName.includes("view") ||
    normalizedName.includes("open")
  ) {
    return path
      ? `${running ? "Reading" : "Read"} ${shortenActivityText(path)}`
      : `${running ? "Reading" : "Read"} content`;
  }
  if (
    normalizedName.includes("search") ||
    normalizedName.includes("find") ||
    normalizedName === "rg"
  ) {
    return query
      ? `${running ? "Searching for" : "Searched for"} “${shortenActivityText(query)}”`
      : `${running ? "Searching" : "Searched"} the workspace`;
  }
  if (
    normalizedName.includes("exec") ||
    normalizedName.includes("shell") ||
    normalizedName.includes("bash") ||
    normalizedName.includes("command")
  ) {
    return command
      ? `${running ? "Running" : "Ran"} ${shortenActivityText(command)}`
      : `${running ? "Running" : "Ran"} a command`;
  }
  return `${running ? "Using" : "Used"} ${humanizeToolName(name)}`;
}

function subagentActivityLabel(name: string, status: AgentActivityToolStatus): string {
  const state = status === "pending" ? "working" : status;
  return `${humanizeToolName(name)} · ${state}`;
}

function humanizeToolName(name: string): string {
  return name.replace(/[_-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function firstString(input: Record<string, unknown> | null, keys: string[]): string | null {
  if (!input) return null;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
