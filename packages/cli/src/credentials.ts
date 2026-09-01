import { chmod, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

/**
 * Credential storage for the eveland CLI: one file per platform origin under
 * ~/.config/eveland/credentials/ (never ~/.eveland — that is the macOS
 * appliance root owned by eveland-ctl; this CLI is a client and may run on
 * machines with no platform installed).
 *
 * Per-origin files make cross-origin races structurally impossible — no
 * shared read-modify-write state, so no lock. Each write lands through a
 * same-directory fsynced temp file + rename, so an interrupted save can
 * never leave a truncated credential; two concurrent logins to the SAME
 * origin resolve to last-writer-wins, which is semantically fine. Directory
 * and files are user-only: tokens are scoped, but they are still credentials.
 */

export type StoredCredential = {
  accessToken: string;
  tokenType: string;
  scopes: string[];
  obtainedAt: string;
  expiresAt: string | null;
};

export function credentialsDir(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  return path.join(configHome, "eveland", "credentials");
}

export function credentialPath(origin: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(credentialsDir(env), `${encodeURIComponent(origin)}.json`);
}

export async function loadCredential(
  origin: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StoredCredential | null> {
  let raw: string;
  try {
    raw = await readFile(credentialPath(origin, env), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(raw) as StoredCredential;
  if (typeof parsed.accessToken !== "string") {
    throw new Error(`Unrecognized credential format at ${credentialPath(origin, env)}.`);
  }
  return parsed;
}

export async function saveCredential(
  origin: string,
  credential: StoredCredential,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const filePath = credentialPath(origin, env);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(credential, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, filePath);
  // Belt and braces on files created under other umasks.
  await chmod(filePath, 0o600);
  return filePath;
}

/** Removes the origin's credential. Returns false when none was stored. */
export async function removeCredential(
  origin: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const filePath = credentialPath(origin, env);
  const existed = await loadCredential(origin, env);
  if (!existed) return false;
  await rm(filePath, { force: true });
  return true;
}

/** Origins with a stored credential (for future listing/cleanup commands). */
export async function listCredentialOrigins(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(credentialsDir(env));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => decodeURIComponent(entry.slice(0, -".json".length)))
    .sort();
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
