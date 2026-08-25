"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type {
  AgentModelUsageBreakdown,
  ModelUsageBreakdown,
  ProjectUsageBreakdown,
  UsageAnalytics,
  UsageRange,
  UsageTotals,
} from "@evelandhq/core/contracts";
import { ChartNoAxesColumnIcon, FolderIcon, PlayIcon } from "lucide-react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { DateTime } from "@/components/date-time";
import { StatusBadge } from "@/components/status-badge";
import { useDisplayTimezone } from "@/components/time-zone-provider";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Project } from "@/lib/api";
import { formatDate, formatDateTime, formatTime } from "@/lib/date-time";
import { cn } from "@/lib/utils";
import {
  completionRate,
  costCoverage,
  formatTokenCount,
  formatUsd,
  percentageDelta,
  usageCoverage,
} from "@/lib/usage";

type UsageScope = { type: "workspace" } | { type: "project"; projectId: string };

type TrendMetric = "sessions" | "modelSteps" | "tokens" | "cost";

type UsageExplorerProps = {
  analytics: UsageAnalytics;
  projects: Project[];
  scope: UsageScope;
};

const rangeLabels: Record<UsageRange, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

const metricLabels: Record<TrendMetric, string> = {
  sessions: "Sessions",
  modelSteps: "Model steps",
  tokens: "Tokens",
  cost: "Cost",
};

function totalTokens(totals: UsageTotals): number {
  return totals.inputTokens + totals.outputTokens;
}

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function formatDelta(value: number | null): string {
  if (value === null) return "No prior baseline";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}% vs previous`;
}

function coverageLabel(totals: UsageTotals): string {
  const coverage = usageCoverage(totals);
  return coverage === null ? "No usage" : `${coverage.toFixed(1)}% reported`;
}

function modelLabel(modelId: string | null): string {
  return modelId ?? "Unknown model";
}

function dimensionValues(row: UsageTotals) {
  return {
    tokens: totalTokens(row),
    completion: completionRate(row),
    coverage: usageCoverage(row),
  };
}

export function UsageExplorer({ analytics, projects, scope }: UsageExplorerProps) {
  const timeZone = useDisplayTimezone();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [metric, setMetric] = useState<TrendMetric>(analytics.modelId ? "tokens" : "sessions");

  const currentProject =
    scope.type === "project" ? projects.find((project) => project.id === scope.projectId) : null;
  const modelOptions = analytics.models.filter(
    (model): model is ModelUsageBreakdown & { modelId: string } => model.modelId !== null,
  );
  const hasUsage = analytics.summary.sessions > 0 || analytics.summary.modelSteps > 0;

  const navigate = (nextPath: string, update?: Record<string, string | null>) => {
    const query = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(update ?? {})) {
      if (value) query.set(key, value);
      else query.delete(key);
    }
    startTransition(() => {
      router.push(`${nextPath}${query.size ? `?${query.toString()}` : ""}`);
    });
  };

  const chartData = useMemo(
    () =>
      analytics.series.map((point) => ({
        bucketStart: point.bucketStart,
        sessions: point.sessions,
        modelSteps: point.modelSteps,
        tokens: totalTokens(point),
        cost: point.costUsd ?? 0,
      })),
    [analytics.series],
  );
  const chartConfig = {
    value: {
      label: metricLabels[metric],
      // chart-1 is the single-series default. chart-2..5 exist only to tell
      // several series apart, and borrowing one here is what made this chart
      // disagree with the identical one on a project overview.
      color: "var(--chart-1)",
    },
  } satisfies ChartConfig;
  const selectedSeries = chartData.map((point) => ({
    bucketStart: point.bucketStart,
    value: point[metric],
  }));
  const selectedTotal =
    metric === "sessions"
      ? analytics.summary.sessions
      : metric === "modelSteps"
        ? analytics.summary.modelSteps
        : metric === "tokens"
          ? totalTokens(analytics.summary)
          : analytics.summary.costUsd;
  const Heading = scope.type === "workspace" ? "h1" : "h2";

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs text-muted-foreground">
            {scope.type === "workspace" ? "Workspace overview" : "Project analytics"}
          </p>
          <Heading
            className={cn(
              "mt-1 font-semibold tracking-tight",
              scope.type === "project" ? "text-2xl" : "text-[17px]",
            )}
          >
            Usage
          </Heading>
          <p className="mt-1 text-sm text-muted-foreground">
            Traffic, model consumption, reliability, and provider-reported cost.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Project
            <Select
              value={scope.type === "workspace" ? "workspace" : scope.projectId}
              onValueChange={(value) => {
                if (!value) return;
                navigate(value === "workspace" ? "/usage" : `/projects/${value}/usage`);
              }}
              disabled={isPending}
            >
              <SelectTrigger size="sm" className="min-w-44">
                <SelectValue>
                  {scope.type === "workspace"
                    ? "All projects"
                    : (currentProject?.name ?? scope.projectId)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent align="end">
                <SelectGroup>
                  <SelectItem value="workspace">All projects</SelectItem>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Model
            <Select
              value={analytics.modelId ?? "all"}
              onValueChange={(value) =>
                navigate(pathname, { model: value === "all" ? null : value })
              }
              disabled={isPending}
            >
              <SelectTrigger size="sm" className="min-w-48 max-w-72">
                <SelectValue>{analytics.modelId ?? "All models"}</SelectValue>
              </SelectTrigger>
              <SelectContent align="end">
                <SelectGroup>
                  <SelectItem value="all">All models</SelectItem>
                  {modelOptions.map((model) => (
                    <SelectItem key={model.modelId} value={model.modelId}>
                      {model.modelId}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Range
            <Select
              value={analytics.range}
              onValueChange={(value) => value && navigate(pathname, { range: value })}
              disabled={isPending}
            >
              <SelectTrigger size="sm" className="min-w-36">
                <SelectValue>{rangeLabels[analytics.range]}</SelectValue>
              </SelectTrigger>
              <SelectContent align="end">
                <SelectGroup>
                  {(Object.entries(rangeLabels) as Array<[UsageRange, string]>).map(
                    ([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ),
                  )}
                </SelectGroup>
              </SelectContent>
            </Select>
          </label>
        </div>
      </header>

      {!hasUsage ? (
        <div className="flex min-h-80 rounded-xl border bg-card">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ChartNoAxesColumnIcon />
              </EmptyMedia>
              <EmptyTitle>No usage recorded</EmptyTitle>
              <EmptyDescription>
                {analytics.modelId
                  ? "This model has no usage in the selected period."
                  : "Run an agent to begin collecting model usage."}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              {scope.type === "project" ? (
                <Link href={`/projects/${scope.projectId}/playground`} className={buttonVariants()}>
                  <PlayIcon data-icon="inline-start" />
                  Open Playground
                </Link>
              ) : (
                <Link href="/projects" className={buttonVariants({ variant: "outline" })}>
                  <FolderIcon data-icon="inline-start" />
                  View projects
                </Link>
              )}
            </EmptyContent>
          </Empty>
        </div>
      ) : (
        <>
          <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <SummaryStat
              label="Sessions"
              value={analytics.summary.sessions.toLocaleString()}
              context={`${formatDelta(percentageDelta(analytics.summary.sessions, analytics.previousSummary.sessions))} · ${analytics.summary.runningSessions} running`}
            />
            <SummaryStat
              label="Model tokens"
              value={formatTokenCount(totalTokens(analytics.summary))}
              context={`${formatDelta(percentageDelta(totalTokens(analytics.summary), totalTokens(analytics.previousSummary)))} · ${formatTokenCount(analytics.summary.cacheReadTokens)} cache read`}
            />
            <SummaryStat
              label="Provider cost"
              value={formatUsd(analytics.summary.costUsd)}
              context={`${formatDelta(percentageDelta(analytics.summary.costUsd ?? 0, analytics.previousSummary.costUsd ?? 0))} · reported only`}
            />
            <SummaryStat
              label="Completed"
              value={formatPercent(completionRate(analytics.summary))}
              context={`${analytics.summary.failedSessions} failed · terminal sessions only`}
            />
          </dl>

          <section className="flex flex-col gap-3" aria-labelledby="usage-trend-heading">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-xs text-muted-foreground">
                  {analytics.modelId ? "Model usage trend" : "Usage trend"}
                </p>
                <h2 id="usage-trend-heading" className="mt-1 text-base font-semibold">
                  {analytics.modelId ?? metricLabels[metric]}
                </h2>
                <p className="mt-1 font-mono text-sm">
                  {metric === "cost"
                    ? formatUsd(selectedTotal as number | null)
                    : metric === "tokens"
                      ? formatTokenCount(selectedTotal as number)
                      : (selectedTotal as number).toLocaleString()}{" "}
                  {metric === "cost" ? "reported USD" : metricLabels[metric].toLowerCase()}
                </p>
              </div>
              <div
                role="group"
                aria-label="Trend metric"
                className="inline-flex rounded-lg bg-muted p-0.5"
              >
                {(Object.keys(metricLabels) as TrendMetric[]).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={metric === value}
                    onClick={() => setMetric(value)}
                    className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                      metric === value
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground"
                    }`}
                  >
                    {metricLabels[value]}
                  </button>
                ))}
              </div>
            </div>
            <div className="rounded-xl border p-4 pb-2">
              <p className="flex items-center gap-2 pb-2 text-xs text-muted-foreground">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-chart-1" />
                {metricLabels[metric]}
              </p>
              <ChartContainer config={chartConfig} className="h-72 w-full">
                <AreaChart accessibilityLayer data={selectedSeries} margin={{ left: 4, right: 12 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="bucketStart"
                    axisLine={false}
                    tickLine={false}
                    tickMargin={10}
                    minTickGap={24}
                    tickFormatter={(value: string) =>
                      analytics.bucket === "hour"
                        ? formatTime(value, timeZone, {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: undefined,
                          })
                        : formatDate(value, timeZone, {
                            month: "short",
                            day: "numeric",
                            year: undefined,
                          })
                    }
                  />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    tickMargin={8}
                    width={56}
                    tickFormatter={(value: number) =>
                      metric === "cost"
                        ? `$${value.toFixed(value < 1 ? 2 : 0)}`
                        : formatTokenCount(value)
                    }
                  />
                  <ChartTooltip
                    cursor={false}
                    content={
                      <ChartTooltipContent
                        labelFormatter={(_label, payload) => {
                          const bucketStart = payload[0]?.payload?.bucketStart;
                          return bucketStart ? formatDateTime(bucketStart, timeZone) : "";
                        }}
                      />
                    }
                  />
                  <Area
                    dataKey="value"
                    type="monotone"
                    fill="var(--color-value)"
                    fillOpacity={0.12}
                    stroke="var(--color-value)"
                    strokeWidth={2}
                  />
                </AreaChart>
              </ChartContainer>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                Usage coverage {formatPercent(usageCoverage(analytics.summary))} ·{" "}
                {analytics.summary.reportedSteps.toLocaleString()} reported,{" "}
                {analytics.summary.missingSteps.toLocaleString()} missing
              </span>
              <span>
                Cost coverage {formatPercent(costCoverage(analytics.summary))} · no estimates
                included
              </span>
            </div>
          </section>

          <div className="grid gap-8 xl:grid-cols-[minmax(0,1.5fr)_minmax(17rem,0.7fr)]">
            {scope.type === "workspace" ? (
              <ProjectBreakdownTable
                rows={analytics.projects}
                range={analytics.range}
                modelId={analytics.modelId}
              />
            ) : (
              <ModelBreakdownTable
                rows={analytics.models}
                selectedModelId={analytics.modelId}
                onSelectModel={(modelId) => navigate(pathname, { model: modelId })}
              />
            )}
            <UsageSignals totals={analytics.summary} projectName={currentProject?.name ?? null} />
          </div>

          {scope.type === "workspace" ? (
            <ModelBreakdownTable
              rows={analytics.models}
              selectedModelId={analytics.modelId}
              onSelectModel={(modelId) => navigate(pathname, { model: modelId })}
            />
          ) : null}

          <AgentModelTable rows={analytics.agentModels} showProject={scope.type === "workspace"} />
          {scope.type === "project" ? <RecentSessionsTable analytics={analytics} /> : null}
        </>
      )}
    </div>
  );
}

function SummaryStat({ label, value, context }: { label: string; value: string; context: string }) {
  return (
    <div className="rounded-xl border p-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-[22px] font-semibold tracking-tight">{value}</dd>
      <dd className="mt-0.5 text-xs text-muted-foreground">{context}</dd>
    </div>
  );
}

function ProjectBreakdownTable({
  rows,
  range,
  modelId,
}: {
  rows: ProjectUsageBreakdown[];
  range: UsageRange;
  modelId: string | null;
}) {
  return (
    <section className="min-w-0" aria-labelledby="project-breakdown-heading">
      <p className="text-xs text-muted-foreground">Attribution</p>
      <h2 id="project-breakdown-heading" className="mt-1 text-base font-semibold">
        Projects
      </h2>
      <div className="mt-3 overflow-x-auto rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Project</TableHead>
              <TableHead className="text-right">Sessions</TableHead>
              <TableHead className="text-right">Completed</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead>Coverage</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const values = dimensionValues(row);
              const query = new URLSearchParams({ range });
              if (modelId) query.set("model", modelId);
              return (
                <TableRow key={row.projectId}>
                  <TableCell>
                    <Link
                      href={`/projects/${row.projectId}/usage?${query.toString()}`}
                      className="font-medium hover:underline"
                    >
                      {row.projectName}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {row.sessions.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {formatPercent(values.completion)}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {formatTokenCount(values.tokens)}
                  </TableCell>
                  <TableCell className="text-right font-mono">{formatUsd(row.costUsd)}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{coverageLabel(row)}</Badge>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function ModelBreakdownTable({
  rows,
  selectedModelId,
  onSelectModel,
}: {
  rows: ModelUsageBreakdown[];
  selectedModelId: string | null;
  onSelectModel: (modelId: string | null) => void;
}) {
  return (
    <section className="min-w-0" aria-labelledby="model-breakdown-heading">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-xs text-muted-foreground">Model attribution</p>
          <h2 id="model-breakdown-heading" className="mt-1 text-base font-semibold">
            Models
          </h2>
        </div>
        {selectedModelId ? (
          <Button variant="ghost" size="sm" onClick={() => onSelectModel(null)}>
            Clear model filter
          </Button>
        ) : null}
      </div>
      <div className="mt-3 overflow-x-auto rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead className="text-right">Sessions</TableHead>
              <TableHead className="text-right">Steps</TableHead>
              <TableHead className="text-right">Input / output</TableHead>
              <TableHead className="text-right">Cache read</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead>Coverage</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.modelId ?? "unknown"}>
                <TableCell>
                  {row.modelId ? (
                    <Button
                      variant="link"
                      className="h-auto px-0"
                      onClick={() => onSelectModel(row.modelId)}
                    >
                      <code>{row.modelId}</code>
                    </Button>
                  ) : (
                    <span className="font-mono text-muted-foreground">Unknown model</span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {row.sessions.toLocaleString()}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {row.modelSteps.toLocaleString()}
                </TableCell>
                <TableCell className="text-right font-mono text-muted-foreground">
                  {formatTokenCount(row.inputTokens)} / {formatTokenCount(row.outputTokens)}
                </TableCell>
                <TableCell className="text-right font-mono text-muted-foreground">
                  {formatTokenCount(row.cacheReadTokens)}
                </TableCell>
                <TableCell className="text-right font-mono">{formatUsd(row.costUsd)}</TableCell>
                <TableCell>
                  <Badge variant="outline">{coverageLabel(row)}</Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function AgentModelTable({
  rows,
  showProject,
}: {
  rows: AgentModelUsageBreakdown[];
  showProject: boolean;
}) {
  return (
    <section className="min-w-0" aria-labelledby="agent-model-heading">
      <p className="text-xs text-muted-foreground">Model attribution</p>
      <h2 id="agent-model-heading" className="mt-1 text-base font-semibold">
        Usage by Eve agent and model
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">One row per agent and model pair.</p>
      <div className="mt-3 overflow-x-auto rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              {showProject ? <TableHead>Project</TableHead> : null}
              <TableHead>Eve agent</TableHead>
              <TableHead>LLM model</TableHead>
              <TableHead className="text-right">Steps</TableHead>
              <TableHead className="text-right">Input / output</TableHead>
              <TableHead className="text-right">Cache read / write</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead>Coverage</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow
                key={`${row.projectId}:${row.agentId ?? row.agentName ?? "unknown"}:${row.modelId ?? "unknown"}`}
              >
                {showProject ? <TableCell>{row.projectName}</TableCell> : null}
                <TableCell>
                  <div className="font-medium">
                    {row.agentName ?? row.agentId ?? "Unknown agent"}
                  </div>
                  {row.agentName && row.agentId ? (
                    <div className="font-mono text-xs text-muted-foreground">{row.agentId}</div>
                  ) : null}
                </TableCell>
                <TableCell className="font-mono">{modelLabel(row.modelId)}</TableCell>
                <TableCell className="text-right font-mono">
                  {row.modelSteps.toLocaleString()}
                </TableCell>
                <TableCell className="text-right font-mono text-muted-foreground">
                  {formatTokenCount(row.inputTokens)} / {formatTokenCount(row.outputTokens)}
                </TableCell>
                <TableCell className="text-right font-mono text-muted-foreground">
                  {formatTokenCount(row.cacheReadTokens)} / {formatTokenCount(row.cacheWriteTokens)}
                </TableCell>
                <TableCell className="text-right font-mono">{formatUsd(row.costUsd)}</TableCell>
                <TableCell>
                  <Badge variant="outline">{coverageLabel(row)}</Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

// Hue only where it carries state meaning: failures are red, partial-data
// warnings amber, and the all-clear row stays grey.
const SIGNAL_DOT = {
  destructive: "bg-destructive",
  warning: "bg-warning",
  muted: "bg-muted-foreground/40",
} as const;

function UsageSignals({
  totals,
  projectName,
}: {
  totals: UsageTotals;
  projectName: string | null;
}) {
  const signals: Array<{ title: string; detail: string; tone: keyof typeof SIGNAL_DOT }> = [];
  if (totals.failedSessions > 0) {
    signals.push({
      title: `${totals.failedSessions.toLocaleString()} failed sessions`,
      detail: projectName
        ? `Within ${projectName} during this period.`
        : "Across the selected workspace scope.",
      tone: "destructive",
    });
  }
  if (totals.missingSteps > 0) {
    signals.push({
      title: `${totals.missingSteps.toLocaleString()} model steps have missing usage`,
      detail: "Token totals exclude fields the provider did not report.",
      tone: "warning",
    });
  }
  const reportedCostCoverage = costCoverage(totals);
  if (reportedCostCoverage !== null && reportedCostCoverage < 100) {
    signals.push({
      title: `Cost coverage is ${reportedCostCoverage.toFixed(1)}%`,
      detail: "Provider cost is partial and Eveland does not estimate the remainder.",
      tone: "warning",
    });
  }
  if (signals.length === 0) {
    signals.push({
      title: "No usage signals need attention",
      detail: "All observed steps reported usage and cost for this period.",
      tone: "muted",
    });
  }

  return (
    <section aria-labelledby="usage-signals-heading">
      <p className="text-xs text-muted-foreground">Selected period</p>
      <h2 id="usage-signals-heading" className="mt-1 text-base font-semibold">
        Needs attention
      </h2>
      <ul className="mt-3 flex flex-col divide-y rounded-xl border">
        {signals.slice(0, 3).map((signal) => (
          <li key={signal.title} className="flex gap-3 p-4">
            <span
              aria-hidden="true"
              className={`mt-1.5 size-1.5 shrink-0 rounded-full ${SIGNAL_DOT[signal.tone]}`}
            />
            <div>
              <p className="text-sm font-medium">{signal.title}</p>
              <p className="mt-1 text-xs text-muted-foreground">{signal.detail}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RecentSessionsTable({ analytics }: { analytics: UsageAnalytics }) {
  return (
    <section className="min-w-0" aria-labelledby="recent-sessions-heading">
      <p className="text-xs text-muted-foreground">Investigation</p>
      <h2 id="recent-sessions-heading" className="mt-1 text-base font-semibold">
        Recent sessions
      </h2>
      <div className="mt-3 overflow-x-auto rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Session</TableHead>
              <TableHead>Trigger</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead>Started</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {analytics.recentSessions.map((session) => (
              <TableRow key={session.id}>
                <TableCell>
                  <Link
                    href={`/projects/${session.projectId}/sessions/${session.id}`}
                    className="font-mono font-medium hover:underline"
                  >
                    {session.id}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">{session.trigger}</TableCell>
                <TableCell>
                  <StatusBadge status={session.status} />
                </TableCell>
                <TableCell className="text-right font-mono">
                  {session.usage.status === "none" || session.usage.status === "missing"
                    ? "—"
                    : formatTokenCount(session.usage.inputTokens + session.usage.outputTokens)}
                </TableCell>
                <TableCell className="text-right font-mono text-muted-foreground">
                  {formatUsd(session.usage.costUsd)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  <DateTime value={session.startedAt} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
