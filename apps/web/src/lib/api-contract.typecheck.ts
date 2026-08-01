// This file is compiled by Web typecheck; it deliberately has no runtime test suite.
import type {
  LogRecord,
  ModelUsageEvent as CoreModelUsageEvent,
  Project as CoreProject,
  ProjectSchedule as CoreProjectSchedule,
  ProjectScheduleSummary as CoreProjectScheduleSummary,
  PublicJob as CorePublicJob,
  PublicSecret as CorePublicSecret,
  ScheduleRecord,
  ScheduleRunListItem,
  ScheduleVersion as CoreScheduleVersion,
  Session as CoreSession,
  SessionEvent as CoreSessionEvent,
  SessionNode as CoreSessionNode,
  SessionTokenUsage as CoreSessionTokenUsage,
  SourceFileRecord,
  SourceRevision as CoreSourceRevision,
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
  SourceFile,
  SourceRevision,
} from "./api";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
        (<Value>() => Value extends Left ? 1 : 2)
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
  Assert<Equal<Session, CoreSession>>,
  Assert<Equal<ScheduleRun, ScheduleRunListItem>>,
  Assert<Equal<SessionTokenUsage, CoreSessionTokenUsage>>,
  Assert<Equal<SessionEvent, CoreSessionEvent>>,
  Assert<Equal<SessionNode, CoreSessionNode>>,
  Assert<Equal<ModelUsageEvent, CoreModelUsageEvent>>,
  Assert<Equal<Job, CorePublicJob>>,
  Assert<Equal<LogLine, LogRecord>>,
  Assert<Equal<SourceRevision, CoreSourceRevision>>,
  Assert<Equal<SourceFile, SourceFileRecord>>,
];

export type { ControlPlaneDomainContracts };
