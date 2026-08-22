import type { RuntimeAdapter } from "../runtime/types.js";
import type { Tracer } from "@opentelemetry/api";

export type ProcessJobOptions = {
  runtime?: RuntimeAdapter;
  runtimeForKind?: (kind: "docker" | "systemd") => RuntimeAdapter;
  appSecretKey?: string;
  allocateHostPort?: () => number | Promise<number>;
  waitForDeployment?: (input: { host: string; port: number; timeoutMs: number }) => Promise<void>;
  workflowPostgresUrl?: string;
  /**
   * Which workflow world the Deployment being launched was built against.
   * Defaults to `shared` — the only kind new builds produce. Only the legacy
   * termination flow passes `legacy_project`, which provisions and injects the
   * per-project legacy database.
   */
  workflowWorldKind?: "shared" | "legacy_project";
  ensureProjectWorkflowWorld?: (
    env: NodeJS.ProcessEnv,
    projectId: string,
  ) => Promise<string | undefined>;
  dropProjectWorkflowWorld?: (env: NodeJS.ProcessEnv, projectId: string) => Promise<void>;
  /** Deployments of a project that still own a non-terminal workflow run. */
  listDeploymentsWithActiveWorkflowRuns?: (
    worldUrl: string | undefined,
    projectId: string,
  ) => Promise<Set<string>>;
  /** Shared database backing `@evelandhq/workflow-world`; overrides EVELAND_WORKFLOW_WORLD_URL. */
  evelandWorkflowWorldUrl?: string;
  /** The shared World's cluster identity; overrides the database-derived value. */
  worldClusterIdentity?: string;
  /** Creates the project's partitions in the shared workflow database. */
  ensureEvelandWorkflowTenant?: (worldUrl: string, projectId: string) => Promise<void>;
  /** Drops them again when the project is deleted. */
  dropEvelandWorkflowTenant?: (worldUrl: string, projectId: string) => Promise<void>;
  nodeEnv?: string;
  dataDir?: string;
  schedulerDispatchSecret?: string;
  schedulerRuntimeSecret?: string;
  schedulerRedeemUrl?: string;
  scheduleRunMaxRuntimeMs?: number;
  identityIssuer?: string;
  identityJwksUrl?: string;
  jobHeartbeatIntervalMs?: number;
  /** Global cap on concurrently running heavy jobs (builds); omitted leaves them uncapped. */
  maxConcurrentHeavyJobs?: number;
  dispatchSchedule?: (input: ScheduleDispatchInput) => Promise<{ sessionIds: string[] }>;
  tracer?: Tracer;
  /** Aborted when this execution's job lease is fenced away; long-running steps must stop. */
  signal?: AbortSignal;
};

export type ScheduleDispatchInput = {
  scheduleRunId: string;
  scheduleKey: string;
  deploymentId: string;
  hostPort: number;
  credential: string;
  runtimeSecret: string;
};
