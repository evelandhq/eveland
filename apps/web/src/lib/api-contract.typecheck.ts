// This file is compiled by Web typecheck; it deliberately has no runtime test suite.
import type {
  LogRecord,
  ModelUsageEvent as CoreModelUsageEvent,
  Project as CoreProject,
  ProjectSchedule as CoreProjectSchedule,
  ProjectScheduleSummary as CoreProjectScheduleSummary,
  AgentEndpoints as CoreAgentEndpoints,
  AuthPrincipal as CoreAuthPrincipal,
  DeploymentOverview as CoreDeploymentOverview,
  PublicDeploymentRecord as CorePublicDeploymentRecord,
  ResolvedAgentRoute as CoreResolvedAgentRoute,
  VariantMetric as CoreVariantMetric,
  PublicJob as CorePublicJob,
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
  TeamInvitation as CoreTeamInvitation,
  TeamMember as CoreTeamMember,
} from "@eveland/core/contracts";
import type { EveVersionInfo as CoreEveVersionInfo } from "@eveland/core/eve-compatibility";
import type {
  EveVersionInfo,
  Job,
  LogLine,
  ModelUsageEvent,
  Project,
  ProjectSchedule,
  ProjectScheduleSummary,
  PublicSecret,
  Schedule,
  ScheduleRun,
  ScheduleVersion,
  Session,
  SessionEvent,
  SessionNode,
  SessionTokenUsage,
  AgentEndpoints,
  AgentRoute,
  Deployment,
  DeploymentOverview,
  SourceFile,
  SourceRevision,
  VariantMetric,
} from "./api";
import type { CurrentMember, Invitation, Member } from "./client-api";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
      ? true
      : false
    : false;

type Assert<Condition extends true> = Condition;

type ControlPlaneDomainContracts = [
  Assert<Equal<EveVersionInfo, CoreEveVersionInfo>>,
  Assert<Equal<Project, CoreProject>>,
  Assert<Equal<PublicSecret, CorePublicSecret>>,
  Assert<Equal<Schedule, ScheduleRecord>>,
  Assert<Equal<ProjectSchedule, CoreProjectSchedule>>,
  Assert<Equal<ScheduleVersion, CoreScheduleVersion>>,
  Assert<Equal<ProjectScheduleSummary, CoreProjectScheduleSummary>>,
  Assert<Equal<Session, CorePublicSession>>,
  Assert<
    Equal<ScheduleRun, Omit<ScheduleRunListItem, "sessions"> & { sessions: CorePublicSession[] }>
  >,
  Assert<Equal<SessionTokenUsage, CoreSessionTokenUsage>>,
  Assert<Equal<SessionEvent, CoreSessionEvent>>,
  Assert<Equal<SessionNode, CoreSessionNode>>,
  Assert<Equal<ModelUsageEvent, CoreModelUsageEvent>>,
  Assert<Equal<Job, CorePublicJob>>,
  Assert<Equal<LogLine, LogRecord>>,
  Assert<Equal<SourceRevision, CorePublicSourceRevision>>,
  Assert<Equal<SourceFile, SourceFileRecord>>,
  Assert<Equal<Member, CoreTeamMember>>,
  Assert<Equal<CurrentMember, CoreAuthPrincipal>>,
  Assert<Equal<Invitation, CoreTeamInvitation>>,
  // The deployment domain: these were hand-written and had drifted (Deployment
  // lost updatedAt; AgentRoute under-described the targets the API returns).
  Assert<Equal<Deployment, CorePublicDeploymentRecord>>,
  Assert<Equal<AgentRoute, CoreResolvedAgentRoute>>,
  Assert<Equal<AgentEndpoints, CoreAgentEndpoints>>,
  Assert<Equal<DeploymentOverview, CoreDeploymentOverview>>,
  Assert<Equal<VariantMetric, CoreVariantMetric>>,
];

export type { ControlPlaneDomainContracts };
