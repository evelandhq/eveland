export type { EveVersionInfo } from "@eveland/core/eve-compatibility";

import type {
  LogRecord,
  ModelUsageEvent as CoreModelUsageEvent,
  Project as CoreProject,
  ProjectSchedule as CoreProjectSchedule,
  ProjectScheduleSummary as CoreProjectScheduleSummary,
  PublicDeploymentRecord as CorePublicDeployment,
  PublicJob as CorePublicJob,
  PublicReleaseRecord as CorePublicRelease,
  PublicSecret as CorePublicSecret,
  PublicSession as CorePublicSession,
  PublicSourceRevision as CorePublicSourceRevision,
  ScheduleRecord,
  ScheduleRunListItem,
  ScheduleVersion as CoreScheduleVersion,
  SessionEvent as CoreSessionEvent,
  SessionNode as CoreSessionNode,
  SessionTokenUsage as CoreSessionTokenUsage,
  SourceFileRecord,
} from "@eveland/core/contracts";

export type Project = CoreProject;
export type PublicSecret = CorePublicSecret;
export type Schedule = ScheduleRecord;
export type ProjectSchedule = CoreProjectSchedule;
export type ScheduleVersion = CoreScheduleVersion;
export type ProjectScheduleSummary = CoreProjectScheduleSummary;
export type Session = CorePublicSession;
export type ScheduleRun = Omit<ScheduleRunListItem, "sessions"> & {
  sessions: Session[];
};

export type ScheduleRunDetail = ScheduleRun & {
  version: ScheduleVersion;
  release: CorePublicRelease;
  deployment: Deployment;
};

export type AgentEndpoints = {
  stable: string | null;
  previews: string[];
};

export type Deployment = {
  id: string;
  deploymentKey: string;
  projectId: string;
  releaseId: string;
  hostPort: number;
  status: "running" | "draining" | "stopped" | "archiving" | "archived" | "failed";
  runtimeKind: "docker" | "systemd";
  createdAt: string;
};

export type AgentRoute = {
  id: string;
  hostname: string;
  kind: "project" | "deployment" | "alias";
  policyRevision: number;
  targets: Array<{ deploymentId: string; weight: number; variantName: string | null }>;
};

export type DeploymentOverview = {
  deployments: Deployment[];
  routes: AgentRoute[];
  retention: Array<{ deployment: Deployment; protected: boolean; reasons: string[] }>;
  /**
   * Release id -> build-derived summary projected from eve's discovery
   * manifest; null for releases built before the projection existed or whose
   * manifest was unreadable.
   */
  releaseSummaries: Record<string, Record<string, unknown> | null>;
};

export type VariantMetric = {
  deploymentId: string | null;
  experimentId: string | null;
  variantName: string;
  sessions: number;
  success: number;
  failure: number;
  averageLatencyMs: number;
  tokens: number;
  costUsd: number;
};

export type SessionTokenUsage = CoreSessionTokenUsage;
export type SessionEvent = CoreSessionEvent;
export type SessionNode = CoreSessionNode;
export type ModelUsageEvent = CoreModelUsageEvent;
export type Job = CorePublicJob;

export type ProjectImportNotice = {
  active: boolean;
  title: string;
  detail: string;
};

export function getProjectImportNotice(job: Job | null): ProjectImportNotice | null {
  if (job?.type !== "import_source") return null;
  if (job.status === "queued") {
    return {
      active: true,
      title: "Repository fetch queued",
      detail: "Waiting for a worker to start fetching the repository.",
    };
  }
  if (job.status === "running") {
    return {
      active: true,
      title: "Fetching repository…",
      detail: "The worker is cloning and validating the latest source.",
    };
  }
  if (job.status !== "failed") return null;
  return {
    active: false,
    title: "Repository fetch failed",
    detail: job.lastError ?? "The repository could not be fetched. Check the worker logs and retry.",
  };
}

export type LogLine = LogRecord;

export type ProjectLogFilter = "all" | LogLine["type"];
export type ProjectLogOrder = "asc" | "desc";

export function selectProjectLogs(
  logs: LogLine[],
  options: { type: ProjectLogFilter; query: string; order: ProjectLogOrder },
): LogLine[] {
  const query = options.query.trim().toLocaleLowerCase();
  const selected = logs.filter((log) => {
    if (options.type !== "all" && log.type !== options.type) return false;
    return query.length === 0 || log.line.toLocaleLowerCase().includes(query);
  });

  return selected.sort((left, right) => {
    const delta = new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
    return options.order === "asc" ? delta : -delta;
  });
}

export type SourceRevision = CorePublicSourceRevision;
export type SourceFile = SourceFileRecord;
