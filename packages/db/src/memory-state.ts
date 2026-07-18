import type {
  ActivationLease,
  AgentAuthCredential,
  AgentAuthTransaction,
  AgentConnection,
  AgentRoute,
  DeploymentRecord,
  GitCredentialRecord,
  Job,
  LogRecord,
  ModelUsageEvent,
  PlatformSecretProfileBinding,
  PlatformSecretProfileRecord,
  Project,
  ProjectSchedule,
  ProjectSchedulerTarget,
  ReleaseRecord,
  RouteTarget,
  RuntimeInstance,
  ScheduleRecord,
  ScheduleRun,
  ScheduleVersion,
  SecretRecord,
  Session,
  SessionBinding,
  SessionEvent,
  SessionNode,
  SourceFileRecord,
  SourcePreflightRecord,
  SourceRevision,
} from "@eveland/core/contracts";

export type MemoryState = {
  projects: Project[];
  gitCredentials: GitCredentialRecord[];
  sourcePreflights: SourcePreflightRecord[];
  agentConnections: AgentConnection[];
  agentAuthCredentials: AgentAuthCredential[];
  agentAuthTransactions: AgentAuthTransaction[];
  secrets: SecretRecord[];
  platformSecretProfiles: PlatformSecretProfileRecord[];
  platformSecretProfileBindings: Array<Omit<PlatformSecretProfileBinding, "profileName" | "profileRevision">>;
  jobs: Job[];
  schedules: ScheduleRecord[];
  sessions: Session[];
  sessionNodes: SessionNode[];
  sessionEvents: SessionEvent[];
  modelUsageEvents: ModelUsageEvent[];
  logs: LogRecord[];
  sourceRevisions: SourceRevision[];
  sourceFiles: SourceFileRecord[];
  releases: ReleaseRecord[];
  deployments: DeploymentRecord[];
  agentRoutes: AgentRoute[];
  routeTargets: RouteTarget[];
  sessionBindings: SessionBinding[];
  projectSchedules: ProjectSchedule[];
  scheduleVersions: ScheduleVersion[];
  projectSchedulerTargets: ProjectSchedulerTarget[];
  scheduleRuns: ScheduleRun[];
  runtimeInstances: RuntimeInstance[];
  activationLeases: ActivationLease[];
};
