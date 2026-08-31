export type { EveVersionInfo } from "@evelandhq/core/eve-compatibility";

import type { IdentityProviderConnection } from "@evelandhq/core/identity";

// Wire shape of /system/identity/providers; shared here so client-api and
// server-api both import it without importing each other.
export type PublicIdentityProvider = Omit<IdentityProviderConnection, "clientSecretEncrypted"> & {
  clientSecretConfigured: boolean;
};

import type {
  LogRecord,
  ModelUsageEvent as CoreModelUsageEvent,
  Project as CoreProject,
  ProjectSchedule as CoreProjectSchedule,
  ProjectScheduleSummary as CoreProjectScheduleSummary,
  AgentEndpoints as CoreAgentEndpoints,
  DeploymentOverview as CoreDeploymentOverview,
  PublicDeploymentRecord as CorePublicDeployment,
  PublicJob as CorePublicJob,
  PublicReleaseRecord as CorePublicRelease,
  PublicSecret as CorePublicSecret,
  PublicSourceRevision as CorePublicSourceRevision,
  ResolvedAgentRoute as CoreResolvedAgentRoute,
  ScheduleRecord,
  ScheduleRunListItem,
  ScheduleRunStatus as CoreScheduleRunStatus,
  ScheduleVersion as CoreScheduleVersion,
  Session as CoreSession,
  SessionEvent as CoreSessionEvent,
  SessionNode as CoreSessionNode,
  SessionTokenUsage as CoreSessionTokenUsage,
  SourceFileRecord,
  VariantMetric as CoreVariantMetric,
} from "@evelandhq/core/contracts";

export type Project = CoreProject;
export type PublicSecret = CorePublicSecret;
export type Schedule = ScheduleRecord;
export type ProjectSchedule = CoreProjectSchedule;
export type ScheduleVersion = CoreScheduleVersion;
export type ProjectScheduleSummary = CoreProjectScheduleSummary;
export type ScheduleRunStatus = CoreScheduleRunStatus;
export type Session = CoreSession;
export type ScheduleRun = Omit<ScheduleRunListItem, "sessions"> & {
  sessions: Session[];
};

export type ScheduleRunDetail = ScheduleRun & {
  version: ScheduleVersion;
  release: CorePublicRelease;
  deployment: Deployment;
};

// Pinned to the core wire shapes (api-contract.typecheck.ts asserts the
// equality): the deployment domain previously hand-wrote these and had
// already drifted -- Deployment lost updatedAt, and AgentRoute described
// narrower targets than the API actually returns.
export type AgentEndpoints = CoreAgentEndpoints;
export type Deployment = CorePublicDeployment;
export type AgentRoute = CoreResolvedAgentRoute;
export type DeploymentOverview = CoreDeploymentOverview;
export type VariantMetric = CoreVariantMetric;

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
    detail:
      job.lastError ?? "The repository could not be fetched. Check the worker logs and retry.",
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
