import { execFile } from "node:child_process";
import { link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
 * Atomically claims supervisor ownership. The record is written COMPLETELY
 * to a private temp file and published with link(2), so it either exists
 * fully formed or not at all — a contender can never observe (and unlink) a
 * half-initialized claim. Exactly one link succeeds; a live verified owner
 * blocks the claim. A stale record (dead or recycled pid) is reclaimed by
 * an atomic rename of exactly the inode that was observed stale: if another
 * contender already replaced it, the observed inode differs and the fresh
 * record is put back untouched. The record is held for the supervisor's
 * lifetime and removed by stop.
 */
export async function claimSupervisorRecord(
  layout: ApplianceLayout,
  record: SupervisorRecord,
  identityOf: ProcessIdentity,
): Promise<{ claimed: true } | { claimed: false; ownerPid: number }> {
  await mkdir(layout.runDir, { recursive: true });
  const pidPath = supervisorPidPath(layout);
  const tempPath = `${pidPath}.claim-${record.pid}-${process.hrtime.bigint()}`;
  await writeFile(tempPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o644 });
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await link(tempPath, pidPath);
        return { claimed: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      // Someone holds the path. Live owner → we lose; stale → reclaim it.
      let observed: { ino: bigint } | null;
      try {
        observed = { ino: (await stat(pidPath, { bigint: true })).ino };
      } catch {
        continue; // vanished between link and stat: retry the link
      }
      const owner = await verifiedSupervisorPid(layout, identityOf);
      if (owner !== null && owner !== record.pid) return { claimed: false, ownerPid: owner };
      const reclaimed = await reclaimStaleRecord(pidPath, observed.ino, record.pid);
      if (!reclaimed) {
        // Someone replaced the stale record while we looked; they own it.
        const current = await verifiedSupervisorPid(layout, identityOf);
        if (current !== null && current !== record.pid)
          return { claimed: false, ownerPid: current };
      }
    }
    const current = await verifiedSupervisorPid(layout, identityOf);
    return { claimed: false, ownerPid: current ?? -1 };
  } finally {
    await rm(tempPath, { force: true });
  }
}

/**
 * Removes the record at pidPath only if it is still the inode observed
 * stale. rename(2) is atomic, so two reclaimers cannot both take the same
 * inode; a reclaimer that grabbed a NEWER record (a fresh claim published
 * after the observation) puts it back with link(2) and reports failure.
 */
async function reclaimStaleRecord(
  pidPath: string,
  staleIno: bigint,
  byPid: number,
): Promise<boolean> {
  const reclaimPath = `${pidPath}.reclaim-${byPid}-${process.hrtime.bigint()}`;
  try {
    await rename(pidPath, reclaimPath);
  } catch {
    return false; // already reclaimed (or replaced) by someone else
  }
  try {
    const moved = await stat(reclaimPath, { bigint: true });
    if (moved.ino !== staleIno) {
      // Not the record we judged stale: a fresh claim. Restore it; if a
      // third claim landed meanwhile, the path is taken and ours is moot.
      await link(reclaimPath, pidPath).catch(() => {});
      return false;
    }
    return true;
  } finally {
    await rm(reclaimPath, { force: true });
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
