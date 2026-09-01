import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
