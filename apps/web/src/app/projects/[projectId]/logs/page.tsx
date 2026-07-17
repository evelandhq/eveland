import { TerminalIcon } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { getLogs } from "@/lib/server-api";

export const dynamic = "force-dynamic";

const LOG_FILTERS = [
  { value: "all", label: "All" },
  { value: "build", label: "Build" },
  { value: "deploy", label: "Deploy" },
  { value: "runtime", label: "Runtime" },
] as const;

export default async function LogsPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ type?: string }>;
}) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  const logs = await getLogs(projectId);
  const activeFilter = LOG_FILTERS.some((filter) => filter.value === query.type) ? query.type : "all";
  const visibleLogs = activeFilter === "all" ? logs : logs.filter((log) => log.type === activeFilter);

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">Logs</h2>
          <p className="text-sm text-muted-foreground">
            Build, deploy, and runtime output. Agent events remain in Session Timeline.
          </p>
        </div>
        <Badge variant="outline">{logs.length} {logs.length === 1 ? "line" : "lines"}</Badge>
      </header>

      <nav className="flex flex-wrap gap-2" aria-label="Filter project logs">
        {LOG_FILTERS.map((filter) => {
          const count = filter.value === "all" ? logs.length : logs.filter((log) => log.type === filter.value).length;
          const active = activeFilter === filter.value;

          return (
            <Link
              key={filter.value}
              href={filter.value === "all" ? `/projects/${projectId}/logs` : `/projects/${projectId}/logs?type=${filter.value}`}
              className={buttonVariants({ variant: active ? "default" : "outline", size: "sm" })}
              aria-current={active ? "page" : undefined}
            >
              {filter.label}
              <span className="font-mono text-[0.7rem] opacity-60">{count}</span>
            </Link>
          );
        })}
      </nav>

      {visibleLogs.length === 0 ? (
        <Empty className="min-h-96 border bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TerminalIcon />
            </EmptyMedia>
            <EmptyTitle>{logs.length === 0 ? "No logs recorded" : `No ${activeFilter} logs`}</EmptyTitle>
            <EmptyDescription>
              {logs.length === 0 ? "Output will appear here after the project starts importing." : "Choose another log type to continue browsing."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <section className="overflow-hidden rounded-xl border bg-foreground text-background shadow-sm">
          <header className="flex items-center justify-between gap-3 border-b border-background/15 px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <TerminalIcon className="size-4" />
              Project log stream
            </div>
            <Badge variant="secondary">{visibleLogs.length} shown</Badge>
          </header>

          <ol className="max-h-[calc(100svh-16rem)] min-h-96 overflow-y-auto px-4 py-3 font-mono text-xs leading-5">
            {visibleLogs.map((log) => (
              <li
                key={log.id}
                className="grid grid-cols-[4.75rem_minmax(0,1fr)] gap-x-3 rounded-sm px-1 py-1.5 transition-colors hover:bg-background/5 sm:grid-cols-[5.5rem_4.5rem_minmax(0,1fr)]"
              >
                <time
                  className="text-background/45 tabular-nums"
                  dateTime={log.createdAt}
                  title={new Date(log.createdAt).toLocaleString()}
                >
                  {new Date(log.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </time>
                <span className="text-background/55">{log.type}</span>
                <span className="col-start-2 whitespace-pre-wrap break-words text-background sm:col-start-3">{log.line}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </section>
  );
}
