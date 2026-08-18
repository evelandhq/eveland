"use client";

import { useMemo, useRef, useState } from "react";
import { SearchIcon, XIcon } from "lucide-react";
import {
  buildSessionTrace,
  formatTraceDuration,
  traceRowPreview,
  type TraceRole,
  type TraceRow,
} from "@/lib/trace";
import { formatTokenCount } from "@/lib/usage";
import { DateTime } from "@/components/date-time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { SessionEvent, SessionNode } from "@/lib/api";

type SessionTraceProps = {
  events: SessionEvent[];
  nodes: SessionNode[];
};

const ROLE_LABEL: Record<TraceRole, string> = {
  user: "USER",
  assistant: "ASSISTANT",
  reasoning: "REASONING",
  tool: "TOOL",
  lifecycle: "SESSION",
};

const ROLE_CHIP: Record<TraceRole, string> = {
  user: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  assistant: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  reasoning: "bg-violet-50 text-violet-500 dark:bg-violet-950/50 dark:text-violet-400",
  tool: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  lifecycle: "bg-muted text-muted-foreground",
};

type MinimapTrack = 0 | 1 | 2;

function minimapTrack(role: TraceRole): MinimapTrack | null {
  if (role === "user") return 0;
  if (role === "assistant" || role === "reasoning") return 1;
  if (role === "tool") return 2;
  return null;
}

const TRACK_BLOCK: Record<MinimapTrack, string> = {
  0: "bg-emerald-500",
  1: "bg-violet-400 dark:bg-violet-500",
  2: "bg-amber-500",
};

export function SessionTrace({ events, nodes }: SessionTraceProps) {
  const trace = useMemo(() => buildSessionTrace(events, nodes), [events, nodes]);
  const searchable = useMemo(
    () => new Map(trace.rows.map((row) => [row.id, searchableText(row)])),
    [trace],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showLifecycle, setShowLifecycle] = useState(true);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  const normalizedQuery = query.trim().toLowerCase();
  const visibleRows = useMemo(
    () =>
      trace.rows.filter(
        (row) =>
          (showLifecycle || row.role !== "lifecycle") &&
          (!normalizedQuery || (searchable.get(row.id) ?? "").includes(normalizedQuery)),
      ),
    [trace, searchable, normalizedQuery, showLifecycle],
  );
  const selected = selectedId ? (trace.rows.find((row) => row.id === selectedId) ?? null) : null;

  const select = (id: string, scrollTo = false) => {
    setSelectedId(id);
    if (scrollTo) {
      rowRefs.current.get(id)?.scrollIntoView({ block: "center" });
    }
  };

  const moveSelection = (delta: 1 | -1) => {
    if (visibleRows.length === 0) return;
    const index = visibleRows.findIndex((row) => row.id === selectedId);
    const next = visibleRows[Math.min(Math.max(index + delta, 0), visibleRows.length - 1)];
    if (next) select(next.id, true);
  };

  if (trace.rows.length === 0) {
    return (
      <div className="flex min-h-40 items-center justify-center px-4 py-8 text-sm text-muted-foreground">
        No timeline events recorded.
      </div>
    );
  }

  return (
    <div className="flex h-[70vh] min-h-[420px] flex-col">
      <div className="flex items-center gap-3 border-b border-border px-4 py-2">
        <Button
          aria-pressed={showLifecycle}
          className={cn("h-7 text-xs", showLifecycle ? "" : "text-muted-foreground")}
          onClick={() => setShowLifecycle((value) => !value)}
          size="sm"
          variant={showLifecycle ? "secondary" : "outline"}
        >
          Lifecycle events
        </Button>
        <div className="ml-auto flex w-64 items-center gap-2">
          <div className="relative w-full">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search trace events"
              className="h-7 pl-8 text-xs"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search payloads, results, tools"
              value={query}
            />
          </div>
          {normalizedQuery ? (
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {visibleRows.length}
            </span>
          ) : null}
        </div>
      </div>

      <TraceMinimap onSelect={(id) => select(id, true)} rows={trace.rows} selectedId={selectedId} />

      <div className="relative flex min-h-0 flex-1">
        <div
          aria-label="Trace events"
          className="min-w-0 flex-1 overflow-y-auto"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              moveSelection(event.key === "ArrowDown" ? 1 : -1);
            }
          }}
          role="listbox"
        >
          {visibleRows.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              No events match this search.
            </div>
          ) : (
            visibleRows.map((row, index) => (
              <TraceRowView
                isSelected={row.id === selectedId}
                key={row.id}
                onSelect={() => select(row.id)}
                ref={(element) => {
                  if (element) rowRefs.current.set(row.id, element);
                  else rowRefs.current.delete(row.id);
                }}
                row={row}
                showTurnTag={row.turn !== null && row.turn !== visibleRows[index - 1]?.turn}
              />
            ))
          )}
        </div>
        {selected ? (
          <TraceDetail
            onClose={() => setSelectedId(null)}
            row={selected}
            sessionStartedAt={trace.startedAt}
          />
        ) : null}
      </div>
    </div>
  );
}

function TraceMinimap({
  onSelect,
  rows,
  selectedId,
}: {
  onSelect: (id: string) => void;
  rows: TraceRow[];
  selectedId: string | null;
}) {
  const blocks = rows.filter((row) => minimapTrack(row.role) !== null);
  if (blocks.length === 0) return null;

  return (
    <div className="flex items-stretch gap-2.5 border-b border-border px-4 py-2">
      <div className="flex shrink-0 flex-col justify-between py-px text-right text-[9px] uppercase tracking-wide text-muted-foreground">
        <span>Input</span>
        <span>Model</span>
        <span>Tools</span>
      </div>
      <div className="min-w-0 flex-1 overflow-x-auto">
        <div className="flex h-full items-stretch">
          {blocks.map((row, index) => {
            const track = minimapTrack(row.role)!;
            const turnBoundary = row.turn !== null && row.turn !== blocks[index - 1]?.turn;
            return (
              <button
                aria-label={`${ROLE_LABEL[row.role]}${row.name ? ` ${row.name}` : ""}`}
                className={cn(
                  "group flex shrink-0 flex-col justify-between px-[1.5px] py-px",
                  turnBoundary && index > 0 && "ml-1.5 border-l border-border pl-[5px]",
                )}
                key={row.id}
                onClick={() => onSelect(row.id)}
                title={`${ROLE_LABEL[row.role]}${row.name ? ` · ${row.name}` : ""}${
                  row.durationMs !== null ? ` · ${formatTraceDuration(row.durationMs)}` : ""
                }`}
                type="button"
              >
                {([0, 1, 2] as const).map((cell) => (
                  <span
                    className={cn(
                      "block w-1.5 rounded-[2px]",
                      row.depth > 0 ? "h-2" : "h-2.5",
                      cell === track
                        ? row.status === "failed"
                          ? "bg-destructive"
                          : TRACK_BLOCK[track]
                        : "bg-transparent",
                      cell === track && "group-hover:brightness-110",
                      cell === track &&
                        row.id === selectedId &&
                        "ring-2 ring-primary ring-offset-1 ring-offset-background",
                      cell === track && row.role === "reasoning" && "opacity-50",
                    )}
                    key={cell}
                  />
                ))}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function TraceRowView({
  isSelected,
  onSelect,
  ref,
  row,
  showTurnTag,
}: {
  isSelected: boolean;
  onSelect: () => void;
  ref: (element: HTMLButtonElement | null) => void;
  row: TraceRow;
  showTurnTag: boolean;
}) {
  return (
    <button
      aria-selected={isSelected}
      className={cn(
        "grid w-full grid-cols-[3.5rem_5.5rem_minmax(0,1fr)_3.5rem] items-baseline gap-x-2.5 border-b border-border py-1.5 pr-3 text-left",
        "hover:bg-muted/50",
        isSelected && "bg-accent shadow-[inset_2px_0_0] shadow-primary",
      )}
      onClick={onSelect}
      ref={ref}
      role="option"
      type="button"
    >
      <span className="self-start text-right">
        {showTurnTag ? (
          <span className="rounded-sm border border-border px-1 py-px font-mono text-[10px] text-muted-foreground">
            Turn {row.turn}
          </span>
        ) : null}
      </span>
      <span className="flex justify-end self-start">
        <span
          className={cn(
            "rounded-sm px-1.5 py-px text-[10px] font-semibold tracking-wide",
            ROLE_CHIP[row.role],
          )}
        >
          {ROLE_LABEL[row.role]}
        </span>
      </span>
      <span
        className="flex min-w-0 items-baseline gap-2"
        style={row.depth > 0 ? { paddingLeft: `${row.depth * 0.875}rem` } : undefined}
      >
        {row.depth > 0 ? (
          <span className="shrink-0 rounded-sm bg-violet-100 px-1.5 py-px font-mono text-[10px] text-violet-700 dark:bg-violet-950 dark:text-violet-300">
            ⤷ {row.agentName}
          </span>
        ) : null}
        {row.status === "failed" ? (
          <span
            aria-label="failed"
            className="size-1.5 shrink-0 self-center rounded-full bg-destructive"
          />
        ) : null}
        <TraceRowPreview row={row} />
      </span>
      <span className="text-right font-mono text-[10px] tabular-nums text-muted-foreground">
        {formatTraceDuration(row.durationMs)}
      </span>
    </button>
  );
}

function TraceRowPreview({ row }: { row: TraceRow }) {
  if (row.role === "tool") {
    return (
      <>
        <span className="shrink-0 font-mono text-xs font-semibold">{row.name}</span>
        <span className="truncate font-mono text-[11px] text-muted-foreground">
          {traceRowPreview(row.payload, 90)}
          {row.result !== null || row.errorText !== null ? (
            <>
              <span className="px-1 text-muted-foreground/60">→</span>
              <span className="text-muted-foreground/70">
                {traceRowPreview(row.errorText ?? row.result, 110)}
              </span>
            </>
          ) : null}
        </span>
      </>
    );
  }
  if (row.role === "lifecycle") {
    return (
      <>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">{row.type}</span>
        <span className="truncate font-mono text-[11px] text-muted-foreground/70">
          {row.usage
            ? `in ${formatTokenCount(row.usage.inputTokens)} · out ${formatTokenCount(row.usage.outputTokens)}`
            : traceRowPreview(row.payload, 110)}
        </span>
      </>
    );
  }
  return (
    <span
      className={cn("truncate text-xs", row.role === "reasoning" && "italic text-muted-foreground")}
    >
      {traceRowPreview(row.payload, 160)}
    </span>
  );
}

function TraceDetail({
  onClose,
  row,
  sessionStartedAt,
}: {
  onClose: () => void;
  row: TraceRow;
  sessionStartedAt: string | null;
}) {
  const offsetMs = sessionStartedAt ? Date.parse(row.eventAt) - Date.parse(sessionStartedAt) : null;

  return (
    <aside
      aria-label="Event detail"
      className="absolute inset-y-0 right-0 flex w-full max-w-[26rem] flex-col border-l border-border bg-card lg:static lg:w-[26rem] lg:shrink-0"
    >
      <div className="flex items-center gap-2 px-4 pt-3">
        <span
          className={cn(
            "rounded-sm px-1.5 py-px text-[10px] font-semibold tracking-wide",
            ROLE_CHIP[row.role],
          )}
        >
          {ROLE_LABEL[row.role]}
        </span>
        <span className="text-xs text-muted-foreground">
          {row.turn !== null ? `Turn ${row.turn} · ` : ""}Step {row.step}
        </span>
        <Button
          aria-label="Close detail"
          className="ml-auto size-6"
          onClick={onClose}
          size="icon"
          variant="ghost"
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>
      <Tabs className="flex min-h-0 flex-1 flex-col gap-0" defaultValue="summary">
        <TabsList className="mx-4 mt-2 h-8" variant="default">
          <TabsTrigger className="text-xs" value="summary">
            Summary
          </TabsTrigger>
          <TabsTrigger className="text-xs" value="payload">
            Payload
          </TabsTrigger>
          <TabsTrigger className="text-xs" value="result">
            Result
          </TabsTrigger>
          <TabsTrigger className="text-xs" value="timing">
            Timing
          </TabsTrigger>
        </TabsList>
        <TabsContent className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-3" value="summary">
          <TraceSummary row={row} />
        </TabsContent>
        <TabsContent className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-3" value="payload">
          <TraceCode value={row.payload} />
        </TabsContent>
        <TabsContent className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-3" value="result">
          {row.errorText !== null ? (
            <TraceCode error value={row.errorText} />
          ) : row.result !== null ? (
            <TraceCode value={row.result} />
          ) : (
            <p className="py-6 text-center text-xs text-muted-foreground">
              This event has no result output.
            </p>
          )}
        </TabsContent>
        <TabsContent className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-3" value="timing">
          <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
            <dt className="text-muted-foreground">Started</dt>
            <dd className="font-mono">
              <DateTime value={row.eventAt} />
            </dd>
            <dt className="text-muted-foreground">Ended</dt>
            <dd className="font-mono">{row.endAt ? <DateTime value={row.endAt} /> : "—"}</dd>
            <dt className="text-muted-foreground">Duration</dt>
            <dd className="font-mono">{formatTraceDuration(row.durationMs) || "—"}</dd>
            <dt className="text-muted-foreground">Offset</dt>
            <dd className="font-mono">
              {offsetMs !== null && Number.isFinite(offsetMs)
                ? `+${(offsetMs / 1000).toFixed(1)} s`
                : "—"}
            </dd>
            <dt className="text-muted-foreground">Event</dt>
            <dd className="break-all font-mono">
              {row.type} · {row.eventId}
            </dd>
          </dl>
        </TabsContent>
      </Tabs>
    </aside>
  );
}

function TraceSummary({ row }: { row: TraceRow }) {
  const hierarchy = [
    "Session",
    ...(row.turn !== null ? [`Turn ${row.turn}`] : []),
    ...(row.agentName ? [`${row.agentName} (subagent)`] : []),
    row.role === "tool"
      ? `Tool call${row.name ? ` · ${row.name}` : ""}`
      : row.role === "lifecycle"
        ? row.type
        : `${ROLE_LABEL[row.role].charAt(0)}${ROLE_LABEL[row.role].slice(1).toLowerCase()} message`,
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1 text-xs">
        {hierarchy.map((part, index) => (
          <span className="flex items-center gap-1" key={part}>
            {index > 0 ? <span className="text-muted-foreground/60">›</span> : null}
            <span className={index === hierarchy.length - 1 ? "font-medium" : undefined}>
              {part}
            </span>
          </span>
        ))}
      </div>
      <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
        {row.status !== null ? (
          <>
            <dt className="text-muted-foreground">Status</dt>
            <dd
              className={cn(
                "flex items-center gap-1.5 font-medium",
                row.status === "failed" && "text-destructive",
              )}
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  row.status === "completed" && "bg-emerald-500",
                  row.status === "failed" && "bg-destructive",
                  row.status === "cancelled" && "bg-muted-foreground",
                  row.status === "pending" && "bg-amber-500",
                )}
              />
              {row.status}
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Agent</dt>
        <dd>{row.agentName ?? "root session"}</dd>
        {row.usage ? (
          <>
            <dt className="text-muted-foreground">Tokens</dt>
            <dd className="font-mono">
              in {formatTokenCount(row.usage.inputTokens)} · out{" "}
              {formatTokenCount(row.usage.outputTokens)} · cache read{" "}
              {formatTokenCount(row.usage.cacheReadTokens)}
            </dd>
          </>
        ) : null}
      </dl>
      {row.payload !== null && row.payload !== undefined ? (
        <section>
          <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Payload
          </h4>
          <TraceCode maxChars={1200} value={row.payload} />
        </section>
      ) : null}
      {row.errorText !== null || row.result !== null ? (
        <section>
          <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Result
          </h4>
          <TraceCode
            error={row.errorText !== null}
            maxChars={1200}
            value={row.errorText ?? row.result}
          />
        </section>
      ) : null}
    </div>
  );
}

function TraceCode({
  error = false,
  maxChars = 50_000,
  value,
}: {
  error?: boolean;
  maxChars?: number;
  value: unknown;
}) {
  const text = formatCode(value);
  const truncated = text.length > maxChars;

  return (
    <pre
      className={cn(
        "max-h-full overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted p-2.5 font-mono text-[11px] leading-relaxed [overflow-wrap:anywhere]",
        error && "border-destructive/50 bg-destructive/10 text-destructive",
      )}
    >
      {truncated ? `${text.slice(0, maxChars)}\n… (truncated)` : text}
    </pre>
  );
}

function formatCode(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "null";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function searchableText(row: TraceRow): string {
  return [
    row.type,
    row.name ?? "",
    row.agentName ?? "",
    formatCode(row.payload),
    formatCode(row.result),
    row.errorText ?? "",
  ]
    .join(" ")
    .toLowerCase();
}
