"use client";

import { ChevronDownIcon, SearchIcon, TerminalIcon, XIcon } from "lucide-react";
import { useDeferredValue, useMemo, useRef, useState } from "react";
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
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  mergeOlderProjectLogs,
  projectLogsPagePath,
  selectProjectLogs,
  type LogLine,
  type ProjectLogFilter,
  type ProjectLogPage,
} from "@/lib/api";
import { apiRequest } from "@/lib/api-transport";
import { formatDateTime } from "@/lib/date-time";

const LOG_FILTERS = [
  { value: "all", label: "All" },
  { value: "build", label: "Build" },
  { value: "deploy", label: "Deploy" },
  { value: "runtime", label: "Runtime" },
] as const;

type LoadedLogs = { filter: ProjectLogFilter; logs: LogLine[]; olderCursor: string | null };

// The project's log history is unbounded, so the viewer holds a window: the
// newest page for the selected type (fetched server-side per tab), extended
// backwards one bounded page at a time. Search filters the loaded window.
export function ProjectLogViewer({
  projectId,
  initialPage,
}: {
  projectId: string;
  initialPage: ProjectLogPage;
}) {
  const [loaded, setLoaded] = useState<LoadedLogs>({
    filter: "all",
    logs: initialPage.logs,
    olderCursor: initialPage.olderCursor,
  });
  const [filter, setFilter] = useState<ProjectLogFilter>("all");
  const [loading, setLoading] = useState<"tab" | "older" | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestId = useRef(0);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const logs = loaded.logs;
  const visibleLogs = useMemo(
    () => selectProjectLogs(logs, { type: filter, query: deferredQuery, order: "desc" }),
    [deferredQuery, filter, logs],
  );

  async function loadPage(nextFilter: ProjectLogFilter, before: string | null) {
    const id = ++requestId.current;
    setLoading(before ? "older" : "tab");
    setLoadError(null);
    try {
      const page = await apiRequest<ProjectLogPage>(
        projectLogsPagePath(projectId, { type: nextFilter, before }),
        { cache: "no-store" },
      );
      if (id !== requestId.current) return;
      setLoaded((current) => ({
        filter: nextFilter,
        logs: before ? mergeOlderProjectLogs(current.logs, page.logs) : page.logs,
        olderCursor: page.olderCursor,
      }));
    } catch (error) {
      if (id !== requestId.current) return;
      setLoadError(error instanceof Error ? error.message : "Could not load logs.");
    } finally {
      if (id === requestId.current) setLoading(null);
    }
  }

  if (initialPage.logs.length === 0) {
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
              const next = value as ProjectLogFilter;
              setFilter(next);
              void loadPage(next, null);
            }
          }}
          className="min-w-0 overflow-x-auto overflow-y-hidden"
        >
          <TabsList className="h-7!" aria-label="Filter project logs">
            {LOG_FILTERS.map((option) => (
              <TabsTrigger key={option.value} value={option.value} className="text-xs">
                {option.label}
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
            placeholder="Search loaded logs..."
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
            <span className="flex items-center gap-2">
              {loading === "tab" ? <Spinner /> : null}
              <Badge variant="outline">
                {visibleLogs.length} of {logs.length} loaded
              </Badge>
            </span>
          </span>
        </header>

        {loadError ? (
          <p role="alert" className="border-b px-4 py-2 text-xs text-destructive">
            {loadError}
          </p>
        ) : null}

        {visibleLogs.length === 0 && !loaded.olderCursor ? (
          <Empty className="min-h-0 flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SearchIcon />
              </EmptyMedia>
              <EmptyTitle>No matching logs</EmptyTitle>
              <EmptyDescription>
                {query ? "Try another search or log type." : "No logs of this type yet."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <ol className="divide-y font-mono text-xs">
              {visibleLogs.map((log) => (
                <ProjectLogRow key={log.id} log={log} />
              ))}
            </ol>
            <div className="flex items-center justify-center gap-2 border-t px-4 py-3 text-xs text-muted-foreground">
              {loaded.olderCursor ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={loading !== null}
                  onClick={() => void loadPage(loaded.filter, loaded.olderCursor)}
                >
                  {loading === "older" ? <Spinner data-icon="inline-start" /> : null}
                  Load older logs
                </Button>
              ) : (
                <span>Beginning of log history</span>
              )}
            </div>
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
