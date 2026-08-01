import type { WorkflowWorldBuildConfig } from "./workflow-world.js";
import type { SchedulerDefinition } from "@eveland/agent-scheduler";

export type RuntimeCommandContext =
  | { packageManager: "pnpm"; hasLockfile: true }
  | { packageManager?: "npm"; hasLockfile: boolean };

export type ReleaseBuildInput = {
  projectId: string;
  releaseId: string;
  sourcePath: string;
  buildDir: string;
  commandContext: RuntimeCommandContext;
  /** Platform-owned durable world injected only into the prepared Release. */
  workflowWorld?: WorkflowWorldBuildConfig;
  /** Aborts the build (the job's lease was fenced away); adapters cancel the build command. */
  signal?: AbortSignal;
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
  /** Platform-owned directory mounted read-only at the fixed Agent policy path. */
  observabilityPolicyDir: string;
};

export type ProcessStartResult = {
  internalPort: number;
  log: string;
};

export type ProcessDiagnostics = {
  state: string;
  logs: string;
};

/**
 * Whether the listening socket on a deployment's loopback port is held by the
 * adapter's own process. "foreign" means another process answers on that port,
 * so any HTTP readiness probe against it would be proven by the wrong
 * responder -- the exact failure mode behind cross-project misrouting.
 */
export type PortOwnership =
  | { status: "owned" }
  | { status: "unbound" }
  | { status: "foreign"; holder: string };

export type RuntimeAdapter = {
  // Structural match for the shared RuntimeKind contract. Keeping the adapter
  // name narrow makes each deployment's persisted runtime owner unambiguous.
  readonly name: "docker" | "systemd";
  buildRelease(input: ReleaseBuildInput): Promise<ReleaseBuildResult>;
  startProcess(input: ProcessStartInput): Promise<ProcessStartResult>;
  inspectProcess?(processName: string): Promise<"missing" | "starting" | "ready" | "stopped" | "failed">;
  /** Best-effort state and recent output captured before an unhealthy process is removed. */
  getProcessDiagnostics?(processName: string): Promise<ProcessDiagnostics>;
  /** Names of currently running processes this runtime owns whose name starts with the prefix. */
  listProcesses?(namePrefix: string): Promise<string[]>;
  /** Whether the process this adapter manages is the one holding the port's listening socket. */
  verifyPortOwnership?(input: { processName: string; port: number }): Promise<PortOwnership>;
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
