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
  /** True while the child's PROCESS GROUP still has members (kill(-pid, 0)). */
  groupAlive: (pid: number) => boolean;
  /** Signal the child's whole process group (kill(-pid, signal)). */
  killGroup: (pid: number, signal: NodeJS.Signals) => void;
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
  /** The last spawned pid — the process-group id for the shutdown sweep. */
  lastPid: number | null;
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
      lastPid: null,
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
    // The direct children are pnpm/tsx/next wrappers: their exit does not
    // prove the real servers exited. Sweep each child's process group until
    // it is actually empty, escalating once.
    await this.sweepProcessGroups();
    await this.publish();
  }

  private lingeringGroups(): Entry[] {
    return this.entries.filter(
      (entry) => entry.lastPid !== null && this.deps.groupAlive(entry.lastPid),
    );
  }

  private async sweepProcessGroups(): Promise<void> {
    if (this.lingeringGroups().length === 0) return;
    for (const entry of this.lingeringGroups()) {
      this.deps.log(
        `${entry.spec.key} left processes in its group; SIGTERM to group ${entry.lastPid}`,
      );
      this.deps.killGroup(entry.lastPid!, "SIGTERM");
    }
    const pollMs = 100;
    for (
      let waited = 0;
      waited < STOP_TERM_GRACE_MS && this.lingeringGroups().length > 0;
      waited += pollMs
    ) {
      await this.deps.sleep(pollMs);
    }
    for (const entry of this.lingeringGroups()) {
      this.deps.log(`group ${entry.lastPid} (${entry.spec.key}) ignored SIGTERM; sending SIGKILL`);
      this.deps.killGroup(entry.lastPid!, "SIGKILL");
    }
    for (
      let waited = 0;
      waited < STOP_KILL_GRACE_MS && this.lingeringGroups().length > 0;
      waited += pollMs
    ) {
      await this.deps.sleep(pollMs);
    }
    for (const entry of this.lingeringGroups()) {
      this.deps.log(
        `group ${entry.lastPid} (${entry.spec.key}) survived SIGKILL; inspect manually`,
      );
    }
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
    entry.lastPid = entry.handle.pid ?? null;
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
    // The wrapper died but the real server may still hold the port inside
    // the old process group; a replacement would crash-loop on it forever.
    // An unkillable group (permissions, D state) keeps the entry in backoff
    // — never respawned into a live group — and is retried at the cap.
    while (!(await this.reapGroup(entry))) {
      if (this.stopping) {
        entry.status = "stopped";
        return;
      }
      entry.status = "backoff";
      this.deps.log(
        `${entry.spec.key}: process group ${entry.lastPid} survived SIGKILL; not respawning into it, retrying in ${RESTART_BACKOFF_CAP_MS / 1000}s`,
      );
      await this.publish();
      await this.deps.sleep(RESTART_BACKOFF_CAP_MS);
    }
    if (this.stopping) {
      entry.status = "stopped";
      return;
    }
    entry.restarts += 1;
    this.spawn(entry);
    await this.publish();
  }

  /**
   * TERM then KILL a dead child's lingering process group before respawning
   * into it. Resolves true only once the group is confirmed empty.
   */
  private async reapGroup(entry: Entry): Promise<boolean> {
    const pid = entry.lastPid;
    if (pid === null || !this.deps.groupAlive(pid)) return true;
    this.deps.log(`${entry.spec.key} left processes in group ${pid}; reaping before restart`);
    this.deps.killGroup(pid, "SIGTERM");
    const pollMs = 100;
    for (
      let waited = 0;
      waited < STOP_TERM_GRACE_MS && this.deps.groupAlive(pid);
      waited += pollMs
    ) {
      await this.deps.sleep(pollMs);
    }
    if (this.deps.groupAlive(pid)) {
      this.deps.killGroup(pid, "SIGKILL");
      for (
        let waited = 0;
        waited < STOP_KILL_GRACE_MS && this.deps.groupAlive(pid);
        waited += pollMs
      ) {
        await this.deps.sleep(pollMs);
      }
    }
    return !this.deps.groupAlive(pid);
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
