import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

async function writeCredentialsFile(filePath: string, file: CredentialsFile): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  // writeFile's mode only applies on creation; re-assert on every save.
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
  const file = await readCredentialsFile(filePath);
  file.origins[origin] = credential;
  await writeCredentialsFile(filePath, file);
  return filePath;
}

/** Removes the origin's credential. Returns false when none was stored. */
export async function removeCredential(
  origin: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const filePath = credentialsPath(env);
  const file = await readCredentialsFile(filePath);
  if (!(origin in file.origins)) return false;
  delete file.origins[origin];
  if (Object.keys(file.origins).length === 0) {
    await rm(filePath, { force: true });
  } else {
    await writeCredentialsFile(filePath, file);
  }
  return true;
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
