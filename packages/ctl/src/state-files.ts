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
 * Atomically claims supervisor ownership. The check-and-publish runs under
 * a mutex directory (`mkdir` is atomic and exclusive) whose owner file
 * names the holder; the record itself is written completely and renamed
 * into place, so it is never visible half-written.
 *
 * A mutex is never broken by age: only one whose recorded holder is
 * DEFINITIVELY dead — gone, or a recycled pid whose start-time identity no
 * longer matches the one recorded — is taken; a dead process cannot be
 * inside the critical section. The break moves the directory
 * aside atomically and re-reads its owner: a live holder's mutex grabbed by
 * mistake (replaced between read and rename) is put back or, failing
 * that, dropped — and every holder re-validates that the canonical mutex
 * still carries its own token immediately before publishing, so a holder
 * whose mutex was moved aside gives up instead of publishing a second
 * record. The record is held for the supervisor's lifetime and removed by
 * stop.
 */
export async function claimSupervisorRecord(
  layout: ApplianceLayout,
  record: SupervisorRecord,
  identityOf: ProcessIdentity,
  options: {
    sleep?: (ms: number) => Promise<void>;
    isAlive?: (pid: number) => boolean;
    /** An owner-less mutex (crash between mkdir and the owner write) is taken after this long. */
    ownerlessGraceMs?: number;
    /** How long a contender waits on a live holder before giving up (always > the grace). */
    waitLimitMs?: number;
  } = {},
): Promise<{ claimed: true } | { claimed: false; ownerPid: number }> {
  await mkdir(layout.runDir, { recursive: true });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const mutex = await acquireClaimMutex(layout, record.pid, identityOf, options);
    try {
      const owner = await verifiedSupervisorPid(layout, identityOf);
      if (owner !== null && owner !== record.pid) return { claimed: false, ownerPid: owner };
      // No owner, a stale (dead or recycled pid) record, or our own: publish —
      // but only if the mutex is still ours (see the doc comment above).
      const pidPath = supervisorPidPath(layout);
      const tempPath = `${pidPath}.tmp-${record.pid}`;
      await writeFile(tempPath, `${JSON.stringify(record)}\n`, "utf8");
      if (!(await mutex.stillHeld())) {
        await rm(tempPath, { force: true });
        continue; // our mutex was moved aside by a breaker: start over
      }
      await rename(tempPath, pidPath);
      return { claimed: true };
    } finally {
      await mutex.release();
    }
  }
  const current = await verifiedSupervisorPid(layout, identityOf);
  return { claimed: false, ownerPid: current ?? -1 };
}

export function supervisorClaimMutexPath(layout: ApplianceLayout): string {
  return path.join(layout.runDir, "supervisor.pid.lock");
}

type ClaimMutex = { stillHeld: () => Promise<boolean>; release: () => Promise<void> };

async function acquireClaimMutex(
  layout: ApplianceLayout,
  pid: number,
  identityOf: ProcessIdentity,
  options: {
    sleep?: (ms: number) => Promise<void>;
    isAlive?: (pid: number) => boolean;
    ownerlessGraceMs?: number;
    waitLimitMs?: number;
  },
): Promise<ClaimMutex> {
  const mutexPath = supervisorClaimMutexPath(layout);
  const ownerPath = path.join(mutexPath, "owner");
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const isAlive = options.isAlive ?? isProcessAlive;
  const ownerlessGraceMs = options.ownerlessGraceMs ?? 30_000;
  // The wait always outlasts the owner-less grace: a crash remnant must be
  // breakable BEFORE a waiter gives up, or it blocks every start for good.
  const waitLimitMs = Math.max(options.waitLimitMs ?? 120_000, ownerlessGraceMs + 10_000);
  // The owner is named by pid AND start-time identity, exactly like the pid
  // record: a pid recycled by an unrelated process must read as dead, not as
  // a live holder that never releases.
  const owner: MutexOwner = {
    pid,
    identity: await identityOf(pid),
    nonce: process.hrtime.bigint().toString(),
  };
  const token = JSON.stringify(owner);
  const readOwner = async (dir: string): Promise<string | null> => {
    try {
      return (await readFile(path.join(dir, "owner"), "utf8")).trim();
    } catch {
      return null;
    }
  };
  const holderIsDead = async (raw: string): Promise<boolean> => {
    const holder = parseMutexOwner(raw);
    if (!holder) return true; // unparseable owner: not a live protocol participant
    if (holder.identity !== null) {
      const current = await identityOf(holder.pid);
      return current === null || current !== holder.identity;
    }
    return !isAlive(holder.pid);
  };

  const startedAt = Date.now();
  for (;;) {
    try {
      await mkdir(mutexPath);
      await writeFile(ownerPath, `${token}\n`, "utf8");
      return {
        stillHeld: async () => (await readOwner(mutexPath)) === token,
        release: async () => {
          if ((await readOwner(mutexPath)) === token) {
            await rm(mutexPath, { recursive: true, force: true });
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    // Held by someone. Break it only when its holder is definitively dead or
    // recycled (or it never got an owner and is old enough to be a remnant).
    const heldBy = await readOwner(mutexPath);
    let breakable = false;
    if (heldBy === null) {
      try {
        const held = await stat(mutexPath);
        breakable = Date.now() - held.mtimeMs > ownerlessGraceMs;
      } catch {
        continue; // released between our mkdir and stat
      }
    } else {
      breakable = await holderIsDead(heldBy);
    }
    if (breakable) {
      const aside = `${mutexPath}.dead-${pid}-${process.hrtime.bigint()}`;
      try {
        await rename(mutexPath, aside);
      } catch {
        continue; // someone else broke or released it first
      }
      const moved = await readOwner(aside);
      if (moved !== heldBy) {
        // Not the dead one: a live holder's mutex replaced it between our
        // read and our rename. Put it back; if the path is taken again by
        // now, the holder will notice at its own re-validation.
        await rename(aside, mutexPath).catch(() => rm(aside, { recursive: true, force: true }));
      } else {
        await rm(aside, { recursive: true, force: true });
      }
      continue;
    }
    if (Date.now() - startedAt > waitLimitMs) {
      throw new Error(`supervisor claim mutex ${mutexPath} never became free`);
    }
    await sleep(10);
  }
}

type MutexOwner = { pid: number; identity: string | null; nonce: string };

function parseMutexOwner(raw: string): MutexOwner | null {
  try {
    const parsed = JSON.parse(raw) as Partial<MutexOwner>;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0)
      return null;
    return {
      pid: parsed.pid,
      identity: typeof parsed.identity === "string" ? parsed.identity : null,
      nonce: typeof parsed.nonce === "string" ? parsed.nonce : "",
    };
  } catch {
    return null;
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
