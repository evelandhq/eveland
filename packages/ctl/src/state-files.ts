import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ApplianceLayout } from "./home.ts";
import type { SupervisorState } from "./supervisor.ts";

/**
 * Supervisor bookkeeping under the appliance root's run/ directory: a pid
 * record naming the supervisor and a JSON snapshot of its children. Both are
 * advisory — liveness is always re-verified against the kernel, and the pid
 * record carries the process's start-time identity (`ps lstart` + command)
 * so a pid recycled after a crash or reboot is detected as stale instead of
 * being SIGTERMed as if it were ours.
 */

const execFileAsync = promisify(execFile);

export type SupervisorRecord = {
  pid: number;
  /** `ps -o lstart=,command=` at write time; null when it could not be read. */
  identity: string | null;
};

/** Reads a process's start-time + command identity; null when the pid is gone. */
export type ProcessIdentity = (pid: number) => Promise<string | null>;

export function defaultProcessIdentity(): ProcessIdentity {
  return async (pid) => {
    try {
      const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart=,command="]);
      const line = stdout.trim();
      return line === "" ? null : line;
    } catch {
      return null;
    }
  };
}

export function supervisorPidPath(layout: ApplianceLayout): string {
  return path.join(layout.runDir, "supervisor.pid");
}

export function supervisorStatePath(layout: ApplianceLayout): string {
  return path.join(layout.runDir, "supervisor.json");
}

export async function writeSupervisorRecord(
  layout: ApplianceLayout,
  record: SupervisorRecord,
): Promise<void> {
  await mkdir(layout.runDir, { recursive: true });
  await writeFile(supervisorPidPath(layout), `${JSON.stringify(record)}\n`, "utf8");
}

/**
 * Atomically claims supervisor ownership. The whole check-and-publish is
 * serialized by a mutex directory (`mkdir` is atomic and exclusive), so no
 * contender can read, misjudge or remove another contender's record at
 * any point of the protocol; the record itself is written completely to a
 * temp file and renamed into place, so it is never visible half-written.
 * A mutex left behind by a crash mid-protocol is broken by age. The record
 * is held for the supervisor's lifetime and removed by stop.
 */
export async function claimSupervisorRecord(
  layout: ApplianceLayout,
  record: SupervisorRecord,
  identityOf: ProcessIdentity,
  options: { sleep?: (ms: number) => Promise<void>; staleLockMs?: number } = {},
): Promise<{ claimed: true } | { claimed: false; ownerPid: number }> {
  await mkdir(layout.runDir, { recursive: true });
  const release = await acquireClaimMutex(layout, options);
  try {
    const owner = await verifiedSupervisorPid(layout, identityOf);
    if (owner !== null && owner !== record.pid) return { claimed: false, ownerPid: owner };
    // No owner, a stale (dead or recycled pid) record, or our own: publish.
    const pidPath = supervisorPidPath(layout);
    const tempPath = `${pidPath}.tmp-${record.pid}`;
    await writeFile(tempPath, `${JSON.stringify(record)}\n`, "utf8");
    await rename(tempPath, pidPath);
    return { claimed: true };
  } finally {
    await release();
  }
}

export function supervisorClaimMutexPath(layout: ApplianceLayout): string {
  return path.join(layout.runDir, "supervisor.pid.lock");
}

async function acquireClaimMutex(
  layout: ApplianceLayout,
  options: { sleep?: (ms: number) => Promise<void>; staleLockMs?: number },
): Promise<() => Promise<void>> {
  const mutexPath = supervisorClaimMutexPath(layout);
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const staleLockMs = options.staleLockMs ?? 10_000;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await mkdir(mutexPath);
      return async () => {
        await rm(mutexPath, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Held by another contender — or abandoned by one that crashed inside
    // the protocol (the critical section is a few file operations long).
    try {
      const held = await stat(mutexPath);
      if (Date.now() - held.mtimeMs > staleLockMs) {
        await rm(mutexPath, { recursive: true, force: true });
        continue;
      }
    } catch {
      continue; // released between our mkdir and stat
    }
    if (attempt > 2_000) throw new Error(`supervisor claim mutex ${mutexPath} never became free`);
    await sleep(10);
  }
}

export async function readSupervisorRecord(
  layout: ApplianceLayout,
): Promise<SupervisorRecord | null> {
  let raw: string;
  try {
    raw = await readFile(supervisorPidPath(layout), "utf8");
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed) as Partial<SupervisorRecord> | number;
    if (typeof parsed === "number") {
      // A legacy plain-number pidfile: an identity-less record.
      return Number.isInteger(parsed) && parsed > 0 ? { pid: parsed, identity: null } : null;
    }
    if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      return {
        pid: parsed.pid,
        identity: typeof parsed.identity === "string" ? parsed.identity : null,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The supervisor pid, verified: the process must exist AND still carry the
 * identity recorded at spawn. A recycled pid (same number, different start
 * time or command) reads as "not running" — signaling it would hit an
 * unrelated process, possibly as root. An identity-less legacy record is
 * accepted only when the live command looks like our supervisor.
 */
export async function verifiedSupervisorPid(
  layout: ApplianceLayout,
  identityOf: ProcessIdentity,
): Promise<number | null> {
  const record = await readSupervisorRecord(layout);
  if (!record) return null;
  const current = await identityOf(record.pid);
  if (current === null) return null;
  if (record.identity !== null) {
    return current === record.identity ? record.pid : null;
  }
  return current.includes("_supervise") ? record.pid : null;
}

export async function removeSupervisorFiles(layout: ApplianceLayout): Promise<void> {
  await rm(supervisorPidPath(layout), { force: true });
  await rm(supervisorStatePath(layout), { force: true });
}

export async function writeSupervisorState(
  layout: ApplianceLayout,
  state: SupervisorState,
): Promise<void> {
  await mkdir(layout.runDir, { recursive: true });
  const tempPath = `${supervisorStatePath(layout)}.tmp-${state.pid}`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tempPath, supervisorStatePath(layout));
}

export async function readSupervisorState(
  layout: ApplianceLayout,
): Promise<SupervisorState | null> {
  try {
    const raw = await readFile(supervisorStatePath(layout), "utf8");
    return JSON.parse(raw) as SupervisorState;
  } catch {
    return null;
  }
}

export function isProcessAlive(
  pid: number,
  kill: (pid: number, signal: 0) => void = process.kill,
): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else — alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
