import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

/**
 * Credential storage for the eveland CLI, keyed by platform origin.
 *
 * Lives under ~/.config/eveland (never ~/.eveland — that is the macOS
 * appliance root owned by eveland-ctl; this CLI is a client and may run on
 * machines with no platform installed). The file and its directory are
 * user-only: tokens are scoped, but they are still credentials.
 */

export type StoredCredential = {
  accessToken: string;
  tokenType: string;
  scopes: string[];
  obtainedAt: string;
  expiresAt: string | null;
};

type CredentialsFile = {
  version: 1;
  origins: Record<string, StoredCredential>;
};

const EMPTY: CredentialsFile = { version: 1, origins: {} };

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  return path.join(configHome, "eveland", "credentials.json");
}

async function readCredentialsFile(filePath: string): Promise<CredentialsFile> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY);
    throw error;
  }
  const parsed = JSON.parse(raw) as CredentialsFile;
  if (parsed.version !== 1 || typeof parsed.origins !== "object" || parsed.origins === null) {
    throw new Error(`Unrecognized credentials file format at ${filePath}.`);
  }
  return parsed;
}

// Concurrent logins/logouts must not lose each other's origins, and an
// interrupted write must never leave a truncated file: every mutation runs
// under an exclusive lock file, and the content lands via a same-directory
// temp file that is fsynced and renamed into place.
const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

async function withCredentialsLock<T>(filePath: string, run: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A crashed process leaves its lock behind; steal it once it is stale.
      const age = await lockAge(lockPath);
      if (age !== null && age > LOCK_STALE_MS) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Another eveland process is updating ${filePath} (remove ${lockPath} if it is stale).`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  try {
    return await run();
  } finally {
    await rm(lockPath, { force: true });
  }
}

async function lockAge(lockPath: string): Promise<number | null> {
  try {
    const handle = await open(lockPath, "r");
    try {
      return Date.now() - (await handle.stat()).mtimeMs;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function writeCredentialsFile(filePath: string, file: CredentialsFile): Promise<void> {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, filePath);
  // Belt and braces on pre-existing files created by other umasks.
  await chmod(filePath, 0o600);
}

export async function loadCredential(
  origin: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StoredCredential | null> {
  const file = await readCredentialsFile(credentialsPath(env));
  return file.origins[origin] ?? null;
}

export async function saveCredential(
  origin: string,
  credential: StoredCredential,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const filePath = credentialsPath(env);
  await withCredentialsLock(filePath, async () => {
    const file = await readCredentialsFile(filePath);
    file.origins[origin] = credential;
    await writeCredentialsFile(filePath, file);
  });
  return filePath;
}

/** Removes the origin's credential. Returns false when none was stored. */
export async function removeCredential(
  origin: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const filePath = credentialsPath(env);
  return withCredentialsLock(filePath, async () => {
    const file = await readCredentialsFile(filePath);
    if (!(origin in file.origins)) return false;
    delete file.origins[origin];
    if (Object.keys(file.origins).length === 0) {
      await rm(filePath, { force: true });
    } else {
      await writeCredentialsFile(filePath, file);
    }
    return true;
  });
}

/**
 * The token for a request: EVELAND_TOKEN always wins (headless CI supplies it
 * directly and must override any interactive login on the machine), otherwise
 * the stored credential for the origin.
 */
export async function resolveToken(
  origin: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ token: string; source: "env" | "stored" } | null> {
  const fromEnv = env.EVELAND_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: "env" };
  const stored = await loadCredential(origin, env);
  if (!stored) return null;
  return { token: stored.accessToken, source: "stored" };
}
