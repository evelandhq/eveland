import type { WorkflowWorldBuildConfig } from "./workflow-world.js";
import type { SchedulerDefinition } from "@eveland/agent-scheduler";

export type RuntimeCommandContext = {
  isEveProject: boolean;
  hasLockfile: boolean;
  scripts: Record<string, string | undefined>;
};

export type ReleaseBuildInput = {
  projectId: string;
  releaseId: string;
  sourcePath: string;
  buildDir: string;
  commandContext: RuntimeCommandContext;
  /** Platform-owned durable world injected only into the prepared Release. */
  workflowWorld?: WorkflowWorldBuildConfig;
};

export type ReleaseBuildResult = {
  releaseRef: string;
  log: string;
  schedulerDefinitions?: SchedulerDefinition[];
};

export type ProcessStartInput = {
  processName: string;
  releaseRef: string;
  port: number;
  env: Record<string, string>;
  commandContext: RuntimeCommandContext;
  /**
   * Durable per-project Eve sandbox session cache dir. For systemd this is the
   * worker/host path; for Docker it is the Docker daemon's host-visible path.
   * The adapter grants or mounts it read-write and exports the fixed
   * sandbox-visible EVELAND_SANDBOX_CACHE_DIR.
   */
  sandboxCacheDir: string;
  /** Deployment-scoped durable observer outbox directory visible to the runtime. */
  observerOutboxDir: string;
};

export type ProcessStartResult = {
  internalPort: number;
  log: string;
};

export type RuntimeAdapter = {
  // Structural match for the shared RuntimeKind contract. Keeping the adapter
  // name narrow makes each deployment's persisted runtime owner unambiguous.
  readonly name: "docker" | "systemd";
  buildRelease(input: ReleaseBuildInput): Promise<ReleaseBuildResult>;
  startProcess(input: ProcessStartInput): Promise<ProcessStartResult>;
  inspectProcess?(processName: string): Promise<"missing" | "starting" | "ready" | "stopped" | "failed">;
  /** Names of currently running processes this runtime owns whose name starts with the prefix. */
  listProcesses?(namePrefix: string): Promise<string[]>;
  ensureProcess?(input: ProcessStartInput): Promise<ProcessStartResult>;
  stopProcess(processName: string): Promise<void>;
  removeRelease?(releaseRef: string): Promise<void>;
};

export function processSafeName(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  // A result made up of nothing but dots (".", "..", "...", ...) is a path
  // traversal segment once callers join it onto a directory (e.g.
  // resolveProjectSandboxCacheDir, which mkdir/chown -R's the result). Not
  // reachable today -- project ids are always nanoids -- but nothing about
  // this function's contract rules it out, so neutralize it here rather than
  // trust every future caller to guard against it.
  if (/^\.+$/.test(sanitized)) {
    return sanitized.replace(/\./g, "-");
  }
  return sanitized;
}
