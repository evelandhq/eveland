import Link from "next/link";
import { SiGit, SiGithub, SiGitlab } from "@icons-pack/react-simple-icons";
import { FolderArchiveIcon, FolderPlusIcon, PlusIcon } from "lucide-react";
import { ProjectDeletionPoller } from "@/components/project-deletion-poller";
import { CompactDateTime } from "@/components/compact-date-time";
import { DateTime } from "@/components/date-time";
import { PageContainer } from "@/components/page-container";
import { RunHistoryBar } from "@/components/run-history-bar";
import { buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { getProjects, type ProjectListItem } from "@/lib/server-api";
import { getEveVersionMessage, getEveVersionStatus } from "@/lib/eve-version";
import { describeProjectSource } from "@/lib/project-source";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Projects",
};

const projectSourceIconByKind = {
  github: SiGithub,
  gitlab: SiGitlab,
  git: SiGit,
  zip: FolderArchiveIcon,
};

type ProjectTone = "running" | "attention" | "scheduled" | "idle" | "stopped" | "failed";

// Tinted pills with a status dot: live states (running/attention/failed) get a
// colour, everything ordinary stays grey. The dot carries the hue so the pill
// text can stay readable at 11px.
const TONE_PILL: Record<ProjectTone, string> = {
  running: "bg-info-subtle text-info-foreground",
  attention: "bg-warning-subtle text-warning-foreground",
  scheduled: "bg-muted text-muted-foreground",
  idle: "bg-muted text-muted-foreground",
  stopped: "bg-muted text-muted-foreground",
  failed: "bg-destructive-subtle text-destructive-foreground",
};

const TONE_DOT: Record<ProjectTone, string | null> = {
  running: "bg-info",
  attention: "bg-warning",
  scheduled: null,
  idle: null,
  stopped: null,
  failed: "bg-destructive",
};

const TONE_ACTIVITY: Record<ProjectTone, string> = {
  running: "text-info-foreground",
  attention: "text-warning-foreground",
  scheduled: "text-muted-foreground",
  idle: "text-muted-foreground",
  stopped: "text-muted-foreground",
  failed: "text-destructive-foreground",
};

type ProjectState = { tone: ProjectTone; label: string; activity: string };

/**
 * Coarse state for the pill, plus the one line that says what the agent is
 * actually doing. Deployment health outranks session state: an agent whose
 * deployment failed is not "idle" just because no session is running.
 */
function describeProjectState(project: ProjectListItem): ProjectState {
  if (project.deletionStatus === "failed")
    return {
      tone: "failed",
      label: "Delete failed",
      activity: project.deletionError ?? "Deletion did not finish",
    };
  if (project.deploymentStatus === "failed")
    return { tone: "failed", label: "Failed", activity: "Latest deployment failed" };
  if (project.latestSessionStatus === "waiting_approval")
    return { tone: "attention", label: "Needs review", activity: "Paused for your approval" };
  if (project.latestSessionStatus === "waiting")
    return { tone: "attention", label: "Needs input", activity: "Waiting on input" };
  if (project.latestSessionStatus === "running")
    return { tone: "running", label: "Running", activity: "Session in progress" };
  if (project.deploymentStatus === "building" || project.deploymentStatus === "starting")
    return { tone: "scheduled", label: "Deploying", activity: "Build in progress" };
  if (
    project.deploymentStatus === "stopped" ||
    project.deploymentStatus === "archiving" ||
    project.deploymentStatus === "archived"
  )
    return { tone: "stopped", label: "Stopped", activity: "Deployment retained, not serving" };
  if (project.deploymentStatus === "not_deployed")
    return { tone: "idle", label: "Not deployed", activity: "No deployment yet" };

  const lastRun =
    project.latestSessionStatus === "failed"
      ? "Last session failed"
      : project.latestSessionStatus === "completed"
        ? "Last session completed"
        : "No sessions yet";
  return project.nextScheduleAt
    ? { tone: "scheduled", label: "Scheduled", activity: lastRun }
    : { tone: "idle", label: "Idle", activity: lastRun };
}

function formatDuration(ms: number | null): string | null {
  if (ms === null) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0 ? `${minutes}m` : `${minutes}m${String(rest).padStart(2, "0")}s`;
  }
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function formatRate(rate: number | null): string | null {
  if (rate === null) return null;
  const percent = rate * 100;
  return `${percent >= 99.95 ? "100" : percent.toFixed(1)}%`;
}

const FILTERS = [
  { key: "all", label: "All" },
  { key: "attention", label: "Needs review" },
  { key: "running", label: "Running" },
  { key: "scheduled", label: "Scheduled" },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

function isFilterKey(value: string | undefined): value is FilterKey {
  return FILTERS.some((filter) => filter.key === value);
}

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const [projects, { state }] = await Promise.all([getProjects(), searchParams]);
  const activeFilter: FilterKey = isFilterKey(state) ? state : "all";

  const described = projects.map((project) => ({
    project,
    state: describeProjectState(project),
    deleting: project.deletionStatus === "deleting",
  }));

  const counts = {
    all: described.length,
    attention: described.filter((entry) => entry.state.tone === "attention").length,
    running: described.filter((entry) => entry.state.tone === "running").length,
    scheduled: described.filter((entry) => entry.state.tone === "scheduled").length,
  } satisfies Record<FilterKey, number>;

  const visible =
    activeFilter === "all"
      ? described
      : described.filter((entry) => entry.state.tone === activeFilter);

  const settled = projects.reduce(
    (total, project) => total + project.activity.succeeded + project.activity.failed,
    0,
  );
  const succeeded = projects.reduce((total, project) => total + project.activity.succeeded, 0);
  const runs = projects.reduce((total, project) => total + project.activity.sessions, 0);
  const fleetRate = settled === 0 ? null : formatRate(succeeded / settled);

  return (
    <div className="min-h-[calc(100svh-3rem)] bg-background">
      <ProjectDeletionPoller active={described.some((entry) => entry.deleting)} />
      <PageContainer className="gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-baseline sm:justify-between">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="text-[17px] font-semibold tracking-tight">Projects</h1>
            <p className="text-sm text-muted-foreground">
              {counts.all} total
              {runs > 0 ? (
                <>
                  {" · "}
                  <span className="font-mono">{runs}</span> runs in 30d
                  {fleetRate ? (
                    <>
                      {" · "}
                      <span className="font-mono text-success-foreground">{fleetRate}</span> ok
                    </>
                  ) : null}
                </>
              ) : null}
            </p>
          </div>
          <Link
            href="/new"
            className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <PlusIcon className="size-4" />
            New project
          </Link>
        </div>

        {projects.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            {FILTERS.map((filter) => {
              const active = filter.key === activeFilter;
              const count = counts[filter.key];
              return (
                <Link
                  key={filter.key}
                  href={filter.key === "all" ? "/projects" : `/projects?state=${filter.key}`}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    active
                      ? "border-transparent bg-primary text-primary-foreground"
                      : "border-border text-muted-foreground hover:border-input",
                    !active && filter.key === "attention" && count > 0
                      ? "border-warning/40 text-warning-foreground"
                      : undefined,
                  )}
                >
                  {filter.label} · {count}
                </Link>
              );
            })}
          </div>
        ) : null}

        {projects.length === 0 ? (
          <div className="flex min-h-80 rounded-xl border bg-card">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FolderPlusIcon />
                </EmptyMedia>
                <EmptyTitle>No projects yet</EmptyTitle>
                <EmptyDescription>
                  Import a Git repository or Zip source to create the first deployment.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Link href="/new" className={buttonVariants()}>
                  <PlusIcon data-icon="inline-start" />
                  New project
                </Link>
              </EmptyContent>
            </Empty>
          </div>
        ) : visible.length === 0 ? (
          <p className="rounded-xl border border-dashed bg-card px-5 py-10 text-center text-sm text-muted-foreground">
            No projects are {FILTERS.find((filter) => filter.key === activeFilter)?.label} right
            now.
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {visible.map(({ project, state: projectState, deleting }) => {
              const source = describeProjectSource(project.importKind, project.gitUrl);
              const ProjectSourceIcon = projectSourceIconByKind[source.kind];
              const { activity } = project;
              const rate = formatRate(activity.successRate);
              const p95 = formatDuration(activity.p95DurationMs);
              const eveStatus = getEveVersionStatus(project.eveVersion);
              return (
                <div
                  key={project.id}
                  aria-busy={deleting}
                  className={cn(
                    // Discrete objects read as cards: white surface, one
                    // hairline. State lives entirely in the pill and the
                    // activity line, never in the card surface.
                    "flex flex-col gap-2.5 rounded-xl border bg-card p-4",
                    deleting && "opacity-70",
                  )}
                >
                  <div className="flex items-center gap-2">
                    {deleting ? (
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                        {project.name}
                      </span>
                    ) : (
                      <Link
                        href={`/projects/${project.id}`}
                        className="min-w-0 flex-1 truncate text-sm font-semibold hover:underline"
                      >
                        {project.name}
                      </Link>
                    )}
                    {deleting ? (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                        <Spinner className="size-3" />
                        Deleting
                      </span>
                    ) : (
                      <span
                        className={cn(
                          "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
                          TONE_PILL[projectState.tone],
                        )}
                      >
                        {TONE_DOT[projectState.tone] ? (
                          <span
                            aria-hidden="true"
                            className={cn("size-1.5 rounded-full", TONE_DOT[projectState.tone])}
                          />
                        ) : null}
                        {projectState.label}
                      </span>
                    )}
                  </div>

                  <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <ProjectSourceIcon aria-hidden="true" className="size-3 shrink-0" />
                    <span className="truncate" title={project.description ?? source.label}>
                      {project.description ?? source.label}
                    </span>
                  </div>

                  <p className={cn("truncate text-xs", TONE_ACTIVITY[projectState.tone])}>
                    {projectState.activity}
                  </p>

                  <div className="flex flex-col gap-1.5">
                    <RunHistoryBar days={activity.days} />
                    <p className="text-[11px] text-muted-foreground">
                      {activity.sessions > 0 ? (
                        <>
                          {activity.sessions} runs
                          {rate ? ` · ${rate} ok` : null}
                          {p95 ? ` · p95 ${p95}` : null}
                        </>
                      ) : (
                        "No runs in the last 30 days"
                      )}
                    </p>
                  </div>

                  <div className="mt-auto flex items-center justify-between border-t pt-2.5 text-[11px] text-muted-foreground">
                    <span
                      className={cn(
                        "truncate font-mono",
                        eveStatus === "current"
                          ? "text-muted-foreground/70"
                          : eveStatus === "upgrade"
                            ? "text-warning-foreground"
                            : "text-destructive-foreground",
                      )}
                      title={
                        eveStatus === "current"
                          ? undefined
                          : getEveVersionMessage(project.eveVersion, eveStatus)
                      }
                    >
                      eve {project.eveVersion.version ?? "unknown"}
                    </span>
                    <span className="truncate">
                      {project.nextScheduleAt ? (
                        <>
                          Next <CompactDateTime value={project.nextScheduleAt} />
                        </>
                      ) : (
                        <>
                          Updated <DateTime value={project.updatedAt} />
                        </>
                      )}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </PageContainer>
    </div>
  );
}
