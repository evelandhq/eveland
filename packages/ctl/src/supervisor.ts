/**
 * The in-process supervisor behind `eveland-ctl start`. macOS has no systemd,
 * so the ctl daemonizes one supervisor that owns the five platform processes:
 * it restarts a crashed child with exponential backoff, publishes a state
 * snapshot for `status`, and turns one SIGTERM into an orderly stop of the
 * whole set. On Linux the same supervisor backs `start --foreground`; the
 * systemd installation path replaces it, not the other way around.
 */

export type SupervisedProcess = {
  key: string;
  label: string;
  cwd: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
};

export type ChildHandle = {
  pid: number | undefined;
  onExit: (callback: (code: number | null, signal: string | null) => void) => void;
  kill: (signal: NodeJS.Signals) => void;
};

export type ChildStatus = "running" | "backoff" | "stopped";

export type ChildState = {
  status: ChildStatus;
  pid: number | null;
  restarts: number;
  lastExit: string | null;
};

export type SupervisorState = {
  pid: number;
  startedAt: string;
  children: Record<string, ChildState>;
};

export type SupervisorDeps = {
  spawnChild: (process: SupervisedProcess) => ChildHandle;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  log: (line: string) => void;
  publishState: (state: SupervisorState) => Promise<void>;
  supervisorPid: number;
};

export const RESTART_BACKOFF_BASE_MS = 1_000;
export const RESTART_BACKOFF_CAP_MS = 30_000;
/** A child that stayed up this long has recovered; its failure streak resets. */
export const STABLE_RESET_MS = 60_000;
export const STOP_TERM_GRACE_MS = 10_000;
export const STOP_KILL_GRACE_MS = 5_000;

export function backoffDelayMs(consecutiveFailures: number): number {
  const exponent = Math.max(0, consecutiveFailures - 1);
  return Math.min(RESTART_BACKOFF_CAP_MS, RESTART_BACKOFF_BASE_MS * 2 ** exponent);
}

type Entry = {
  spec: SupervisedProcess;
  handle: ChildHandle | null;
  status: ChildStatus;
  consecutiveFailures: number;
  spawnedAtMs: number;
  restarts: number;
  lastExit: string | null;
};

export class Supervisor {
  private readonly entries: Entry[];
  private readonly deps: SupervisorDeps;
  private readonly startedAt: string;
  private stopping = false;

  constructor(processes: SupervisedProcess[], deps: SupervisorDeps) {
    this.deps = deps;
    this.startedAt = deps.now().toISOString();
    this.entries = processes.map((spec) => ({
      spec,
      handle: null,
      status: "stopped" as ChildStatus,
      consecutiveFailures: 0,
      spawnedAtMs: 0,
      restarts: 0,
      lastExit: null,
    }));
  }

  async start(): Promise<void> {
    for (const entry of this.entries) this.spawn(entry);
    await this.publish();
  }

  state(): SupervisorState {
    const children: Record<string, ChildState> = {};
    for (const entry of this.entries) {
      children[entry.spec.key] = {
        status: entry.status,
        pid: entry.handle?.pid ?? null,
        restarts: entry.restarts,
        lastExit: entry.lastExit,
      };
    }
    return { pid: this.deps.supervisorPid, startedAt: this.startedAt, children };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const entry of this.entries) {
      if (entry.status === "running" && entry.handle) {
        this.deps.log(`stopping ${entry.spec.key} (pid ${entry.handle.pid ?? "?"})`);
        entry.handle.kill("SIGTERM");
      } else {
        entry.status = "stopped";
      }
    }
    await this.waitForAllStopped(STOP_TERM_GRACE_MS);
    for (const entry of this.entries) {
      if (entry.status === "running" && entry.handle) {
        this.deps.log(`${entry.spec.key} ignored SIGTERM; sending SIGKILL`);
        entry.handle.kill("SIGKILL");
      }
    }
    await this.waitForAllStopped(STOP_KILL_GRACE_MS);
    await this.publish();
  }

  allStopped(): boolean {
    return this.entries.every((entry) => entry.status === "stopped");
  }

  private async waitForAllStopped(graceMs: number): Promise<void> {
    const pollMs = 100;
    for (let waited = 0; waited < graceMs && !this.allStopped(); waited += pollMs) {
      await this.deps.sleep(pollMs);
    }
  }

  private spawn(entry: Entry): void {
    entry.handle = this.deps.spawnChild(entry.spec);
    entry.status = "running";
    entry.spawnedAtMs = this.deps.now().getTime();
    this.deps.log(`started ${entry.spec.key} (pid ${entry.handle.pid ?? "?"})`);
    entry.handle.onExit((code, signal) => {
      void this.handleExit(entry, code, signal);
    });
  }

  private async handleExit(
    entry: Entry,
    code: number | null,
    signal: string | null,
  ): Promise<void> {
    entry.lastExit = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
    entry.handle = null;
    if (this.stopping) {
      entry.status = "stopped";
      this.deps.log(`${entry.spec.key} exited (${entry.lastExit})`);
      return;
    }
    const uptimeMs = this.deps.now().getTime() - entry.spawnedAtMs;
    if (uptimeMs >= STABLE_RESET_MS) entry.consecutiveFailures = 0;
    entry.consecutiveFailures += 1;
    const delay = backoffDelayMs(entry.consecutiveFailures);
    entry.status = "backoff";
    this.deps.log(
      `${entry.spec.key} exited (${entry.lastExit}) after ${Math.round(uptimeMs / 1000)}s; restarting in ${delay / 1000}s`,
    );
    await this.publish();
    await this.deps.sleep(delay);
    if (this.stopping) {
      entry.status = "stopped";
      return;
    }
    entry.restarts += 1;
    this.spawn(entry);
    await this.publish();
  }

  private async publish(): Promise<void> {
    try {
      await this.deps.publishState(this.state());
    } catch {
      // State publication is observability, not control: a full disk must not
      // take the supervisor down with it.
    }
  }
}
