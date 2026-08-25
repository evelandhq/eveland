"use client";

import { ChevronDownIcon, SearchIcon, TerminalIcon, XIcon } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import { useDisplayTimezone } from "@/components/time-zone-provider";
import { Badge } from "@/components/ui/badge";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { selectProjectLogs, type LogLine, type ProjectLogFilter } from "@/lib/api";
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
    () => selectProjectLogs(logs, { type: filter, query: deferredQuery, order: "desc" }),
    [deferredQuery, filter, logs],
  );

  if (logs.length === 0) {
    return (
      <Empty className="min-h-96 flex-1 rounded-xl border bg-card">
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
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs
          value={filter}
          onValueChange={(value) => {
            if (LOG_FILTERS.some((option) => option.value === value)) {
              setFilter(value as ProjectLogFilter);
            }
          }}
          className="min-w-0 overflow-x-auto overflow-y-hidden"
        >
          <TabsList className="h-7!" aria-label="Filter project logs">
            {LOG_FILTERS.map((option) => (
              <TabsTrigger key={option.value} value={option.value} className="text-xs">
                {option.label} <span className="tabular-nums">{counts[option.value]}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <InputGroup className="w-full shrink-0 sm:ml-auto sm:w-64">
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
      </div>

      <section
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card"
        aria-label="Project log stream"
      >
        <header className="grid grid-cols-[7.25rem_4.5rem_minmax(0,1fr)] items-center gap-3 border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
          <span>Timestamp</span>
          <span>Type</span>
          <span className="flex items-center justify-between gap-3">
            Message
            <Badge variant="outline">{visibleLogs.length} shown</Badge>
          </span>
        </header>

        {visibleLogs.length === 0 ? (
          <Empty className="min-h-0 flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SearchIcon />
              </EmptyMedia>
              <EmptyTitle>No matching logs</EmptyTitle>
              <EmptyDescription>Try another search or log type.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
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
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate min-w-0 flex-1 text-left leading-5">{compactLine}</span>
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
            className="group/trigger grid w-full grid-cols-[7.25rem_4.5rem_minmax(0,1fr)] items-center gap-3 px-4 py-2 text-left"
            aria-label={`Show full log from ${fullTimestamp}`}
          >
            {row}
          </CollapsibleTrigger>
          <CollapsibleContent className="border-t bg-muted/25 px-4 py-3 sm:pl-[14.25rem]">
            <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5">
              {log.line}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      ) : (
        <div className="grid grid-cols-[7.25rem_4.5rem_minmax(0,1fr)] items-center gap-3 px-4 py-2">
          {row}
        </div>
      )}
    </li>
  );
}
