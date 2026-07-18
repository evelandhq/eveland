import type { RuntimeAdapter } from "../runtime/types.js";

export type ProcessJobOptions = {
  runtime?: RuntimeAdapter;
  runtimeForKind?: (kind: "docker" | "systemd") => RuntimeAdapter;
  appSecretKey?: string;
  allocateHostPort?: () => number | Promise<number>;
  waitForDeployment?: (input: { host: string; port: number; timeoutMs: number }) => Promise<void>;
  workflowPostgresUrl?: string;
  ensureProjectWorkflowWorld?: (env: NodeJS.ProcessEnv, projectId: string) => Promise<string | undefined>;
  dropProjectWorkflowWorld?: (env: NodeJS.ProcessEnv, projectId: string) => Promise<void>;
  nodeEnv?: string;
  dataDir?: string;
  schedulerDispatchSecret?: string;
  schedulerRuntimeSecret?: string;
  schedulerRedeemUrl?: string;
  jobHeartbeatIntervalMs?: number;
  dispatchSchedule?: (input: ScheduleDispatchInput) => Promise<{ sessionIds: string[] }>;
};

export type ScheduleDispatchInput = {
  scheduleRunId: string;
  scheduleKey: string;
  deploymentId: string;
  hostPort: number;
  credential: string;
  runtimeSecret: string;
};
