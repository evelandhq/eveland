"use client";

import { ChevronDownIcon, ChevronsUpDownIcon, SearchIcon, TerminalIcon, XIcon } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import { useDisplayTimezone } from "@/components/time-zone-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  selectProjectLogs,
  type LogLine,
  type ProjectLogFilter,
  type ProjectLogOrder,
} from "@/lib/api";
import { formatDateTime } from "@/lib/date-time";

const LOG_FILTERS = [
  { value: "all", label: "All" },
  { value: "build", label: "Build" },
  { value: "deploy", label: "Deploy" },
  { value: "runtime", label: "Runtime" },
] as const;

export function ProjectLogViewer({ logs }: { logs: LogLine[] }) {
  const [filter, setFilter] = useState<ProjectLogFilter>("all");
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState<ProjectLogOrder>("desc");
  const deferredQuery = useDeferredValue(query);
  const counts = useMemo(
    () => ({
      all: logs.length,
      build: logs.filter((log) => log.type === "build").length,
      deploy: logs.filter((log) => log.type === "deploy").length,
      runtime: logs.filter((log) => log.type === "runtime").length,
    }),
    [logs],
  );
  const visibleLogs = useMemo(
    () => selectProjectLogs(logs, { type: filter, query: deferredQuery, order }),
    [deferredQuery, filter, logs, order],
  );

  if (logs.length === 0) {
    return (
      <Empty className="min-h-96 border bg-card">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TerminalIcon />
          </EmptyMedia>
          <EmptyTitle>No logs recorded</EmptyTitle>
          <EmptyDescription>
            Output will appear here after the project starts importing.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
        <InputGroup className="xl:max-w-xl">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search logs"
            placeholder="Search logs..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                aria-label="Clear search"
                onClick={() => setQuery("")}
              >
                <XIcon />
              </InputGroupButton>
            </InputGroupAddon>
          ) : null}
        </InputGroup>

        <div className="flex flex-wrap items-center justify-between gap-2 xl:ml-auto xl:justify-end">
          <ToggleGroup
            value={[filter]}
            onValueChange={(values) => {
              const value = values[0] as ProjectLogFilter | undefined;
              if (value) setFilter(value);
            }}
            variant="outline"
            size="sm"
            spacing={0}
            aria-label="Filter project logs"
          >
            {LOG_FILTERS.map((option) => (
              <ToggleGroupItem key={option.value} value={option.value}>
                {option.label} <span className="tabular-nums">{counts[option.value]}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          <Button
            variant="outline"
            size="sm"
            aria-label={
              order === "desc"
                ? "Newest first. Switch to oldest first"
                : "Oldest first. Switch to newest first"
            }
            onClick={() => setOrder((current) => (current === "desc" ? "asc" : "desc"))}
          >
            <ChevronsUpDownIcon data-icon="inline-start" />
            {order === "desc" ? "Newest first" : "Oldest first"}
          </Button>
        </div>
      </div>

      <section
        className="overflow-hidden rounded-xl border bg-card shadow-xs"
        aria-label="Project log stream"
      >
        <header className="grid grid-cols-[6.5rem_4.75rem_minmax(0,1fr)] items-center gap-3 border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground sm:grid-cols-[9.5rem_5.5rem_minmax(0,1fr)]">
          <span>Timestamp</span>
          <span>Type</span>
          <span className="flex items-center justify-between gap-3">
            Message
            <Badge variant="outline">{visibleLogs.length} shown</Badge>
          </span>
        </header>

        {visibleLogs.length === 0 ? (
          <Empty className="min-h-96">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SearchIcon />
              </EmptyMedia>
              <EmptyTitle>No matching logs</EmptyTitle>
              <EmptyDescription>Try another search or log type.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          // Fill the page. The offset is everything above the scroll area plus
          // the container's bottom padding, measured rather than guessed:
          // project header + PageContainer py-6 + this card's own header =
          // 158px, plus 24px of breathing room below = 182px. Mobile adds back
          // the 3rem app header the desktop layout hides.
          <ScrollArea className="h-[calc(100svh-14.375rem)] min-h-96 md:h-[calc(100svh-11.375rem)]">
            <ol className="divide-y font-mono text-xs">
              {visibleLogs.map((log) => (
                <ProjectLogRow key={log.id} log={log} />
              ))}
            </ol>
          </ScrollArea>
        )}
      </section>
    </div>
  );
}

function ProjectLogRow({ log }: { log: LogLine }) {
  const timeZone = useDisplayTimezone();
  const compactLine = log.line.replace(/\s+/g, " ").trim();
  const isExpandable = log.line.includes("\n") || compactLine.length > 220;
  const fullTimestamp = formatDateTime(log.createdAt, timeZone);
  const compactTimestamp = formatDateTime(log.createdAt, timeZone, {
    year: undefined,
    month: "2-digit",
    day: "2-digit",
  });
  const row = (
    <>
      <time
        className="truncate text-muted-foreground tabular-nums"
        dateTime={log.createdAt}
        title={fullTimestamp}
        suppressHydrationWarning
      >
        {compactTimestamp}
      </time>
      <span>
        <Badge variant="outline">{log.type}</Badge>
      </span>
      <span className="flex min-w-0 items-start gap-2">
        <span className="line-clamp-2 min-w-0 flex-1 break-words text-left leading-5">
          {compactLine}
        </span>
        {isExpandable ? (
          <ChevronDownIcon className="mt-0.5 shrink-0 transition-transform group-data-[panel-open]/trigger:rotate-180" />
        ) : null}
      </span>
    </>
  );

  return (
    <li className="group/log transition-colors hover:bg-muted/35">
      {isExpandable ? (
        <Collapsible>
          <CollapsibleTrigger
            className="group/trigger grid w-full grid-cols-[6.5rem_4.75rem_minmax(0,1fr)] items-start gap-3 px-4 py-2.5 text-left sm:grid-cols-[9.5rem_5.5rem_minmax(0,1fr)]"
            aria-label={`Show full log from ${fullTimestamp}`}
          >
            {row}
          </CollapsibleTrigger>
          <CollapsibleContent className="border-t bg-muted/25 px-4 py-3 sm:pl-[16rem]">
            <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5">
              {log.line}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      ) : (
        <div className="grid grid-cols-[6.5rem_4.75rem_minmax(0,1fr)] items-start gap-3 px-4 py-2.5 sm:grid-cols-[9.5rem_5.5rem_minmax(0,1fr)]">
          {row}
        </div>
      )}
    </li>
  );
}
