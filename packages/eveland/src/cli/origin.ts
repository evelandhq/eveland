import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Resolves the platform origin a command talks to.
 *
 * Order: an explicit --origin flag wins; otherwise a machine with an appliance
 * install (EVELAND_HOME) defaults to that instance's EVELAND_PUBLIC_ORIGIN
 * from etc/eveland.env; otherwise the command must be told where the platform
 * is. There is no silent localhost fallback — a wrong default would send
 * credentials to the wrong instance.
 */
export async function resolveOrigin(
  flagValue: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (flagValue) return normalizeOrigin(flagValue);
  const home = env.EVELAND_HOME?.trim();
  if (home) {
    const fromEnvFile = await readPublicOrigin(path.join(home, "etc", "eveland.env"));
    if (fromEnvFile) return normalizeOrigin(fromEnvFile);
  }
  throw new Error(
    "No platform origin. Pass --origin <url> (or set EVELAND_HOME to a local install).",
  );
}

export function normalizeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`Invalid origin '${value}': expected a URL like https://eveland.example.com`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Invalid origin '${value}': only http(s) origins are supported.`);
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`Invalid origin '${value}': pass just the origin, no path or query.`);
  }
  return url.origin;
}

async function readPublicOrigin(envFilePath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(envFilePath, "utf8");
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    const match = /^\s*(?:export\s+)?EVELAND_PUBLIC_ORIGIN\s*=\s*(.+?)\s*$/.exec(line);
    if (match?.[1]) return match[1].replace(/^["']|["']$/g, "");
  }
  return null;
}
