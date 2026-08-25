"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  BotIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleDashedIcon,
  GlobeIcon,
  SearchIcon,
  SquareTerminalIcon,
  XCircleIcon,
} from "lucide-react";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export type AgentActivityStatus = "completed" | "failed" | "cancelled" | "running";
export type AgentActivityToolStatus = "completed" | "failed" | "cancelled" | "pending";

export function AgentActivity({
  children,
  compact = false,
  count,
  status,
}: {
  children: ReactNode;
  compact?: boolean;
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
    <Collapsible
      className={cn("group/activity", !compact && "overflow-hidden rounded-xl border")}
      onOpenChange={setOpen}
      open={open}
    >
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center text-left text-muted-foreground transition-colors hover:text-foreground",
          compact ? "gap-1.5 text-xs leading-4" : "gap-2 px-3 py-2 text-sm",
        )}
      >
        <AgentActivityStatusIcon compact={compact} status={status} />
        <span className="font-medium text-foreground">{title}</span>
        <span>· {countLabel}</span>
        <ChevronDownIcon
          className={cn(
            "ml-auto transition-transform group-data-[panel-open]/activity:rotate-180",
            compact ? "size-3" : "size-4",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          "flex flex-col data-[ending-style]:animate-out data-[starting-style]:animate-in",
          compact ? "mt-1 gap-1.5" : "gap-2 border-t border-border px-3 py-2.5",
        )}
      >
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function AgentActivityReasoning({
  compact = false,
  isStreaming = false,
  text,
}: {
  compact?: boolean;
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
        className={compact ? "gap-1.5 text-xs leading-4" : "text-xs"}
        getThinkingMessage={(streaming) => (
          <span>{streaming ? "Reasoning…" : "Reasoned through the approach"}</span>
        )}
      />
      <ReasoningContent
        className={compact ? "mt-1 text-xs leading-4" : "mt-2 text-xs leading-relaxed"}
      >
        {text}
      </ReasoningContent>
    </Reasoning>
  );
}

export function AgentActivityTool({
  children,
  compact = false,
  errorText,
  input,
  kind = "tool",
  name,
  openOnAttention = false,
  output,
  status,
}: {
  children?: ReactNode;
  compact?: boolean;
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
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center text-left text-muted-foreground transition-colors hover:text-foreground",
          compact ? "gap-1.5 text-xs leading-4" : "gap-2 py-1 text-xs",
        )}
      >
        <AgentActivityToolIcon compact={compact} kind={kind} name={name} status={status} />
        <span className="truncate text-foreground">{label}</span>
        <span className="sr-only">{status}</span>
        <ChevronDownIcon
          className={cn(
            "ml-auto shrink-0 transition-transform group-data-[panel-open]/tool:rotate-180",
            compact ? "size-3" : "size-3.5",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          "flex flex-col data-[ending-style]:animate-out data-[starting-style]:animate-in",
          compact
            ? "mt-1 gap-2 text-xs leading-4 [&_code]:text-xs [&_pre]:text-xs"
            : "ml-5 mt-2 gap-3 pb-2 text-xs [&_code]:text-xs [&_pre]:text-xs",
        )}
      >
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

function AgentActivityStatusIcon({
  compact,
  status,
}: {
  compact: boolean;
  status: AgentActivityStatus;
}) {
  const className = compact ? "size-3" : "size-4";
  if (status === "running") return <Spinner className={className} />;
  if (status === "failed") return <XCircleIcon className={cn(className, "text-destructive")} />;
  if (status === "cancelled") return <CircleDashedIcon className={className} />;
  return <CheckCircle2Icon className={className} />;
}

function AgentActivityToolIcon({
  compact,
  kind,
  name,
  status,
}: {
  compact: boolean;
  kind: "tool" | "subagent";
  name: string;
  status: AgentActivityToolStatus;
}) {
  const className = cn(
    "shrink-0",
    compact ? "size-3" : "size-3.5",
    status === "pending" && "animate-pulse",
    status === "failed" && "text-destructive",
    status === "cancelled" && "opacity-60",
  );

  if (kind === "subagent") return <BotIcon className={className} />;
  const iconKind = agentActivityToolIconKind(name);
  if (iconKind === "terminal") return <SquareTerminalIcon className={className} />;
  if (iconKind === "search") return <SearchIcon className={className} />;
  if (iconKind === "globe") return <GlobeIcon className={className} />;
  if (status === "pending") return <Spinner className={className} />;
  if (status === "failed") return <XCircleIcon className={className} />;
  if (status === "cancelled") return <CircleDashedIcon className={className} />;
  return <CheckCircle2Icon className={className} />;
}

export function agentActivityToolIconKind(name: string): "globe" | "terminal" | "search" | null {
  const normalizedName = name.toLowerCase();
  if (isCommandToolName(normalizedName)) return "terminal";
  if (isSearchToolName(normalizedName)) return "search";
  if (["web_fetch", "web-fetch", "webfetch"].includes(normalizedName)) return "globe";
  return null;
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
  if (isSearchToolName(normalizedName)) {
    return query
      ? `${running ? "Searching for" : "Searched for"} “${shortenActivityText(query)}”`
      : `${running ? "Searching" : "Searched"} the workspace`;
  }
  if (isCommandToolName(normalizedName)) {
    return command
      ? `${running ? "Running" : "Ran"} ${shortenActivityText(command)}`
      : `${running ? "Running" : "Ran"} a command`;
  }
  return `${running ? "Using" : "Used"} ${humanizeToolName(name)}`;
}

function isSearchToolName(name: string): boolean {
  return name.includes("search") || name.includes("find") || name.includes("grep") || name === "rg";
}

function isCommandToolName(name: string): boolean {
  return (
    name.includes("exec") ||
    name.includes("shell") ||
    name.includes("bash") ||
    name.includes("command")
  );
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
