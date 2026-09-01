import { readFile } from "node:fs/promises";
import path from "node:path";
import { applianceLayout, resolveApplianceRoot } from "./home.ts";

/**
 * The platform configuration eveland-ctl supervises with. An appliance install
 * renders etc/eveland.env; a plain development checkout keeps the repository's
 * .env. The first that exists wins, and every supervised process receives the
 * same parsed values — the file is the single configuration source, never
 * per-process overrides.
 */

export type PlatformEnvFile = {
  path: string;
  values: Record<string, string>;
};

export function parseEnvFile(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    let value = match[2]!;
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export async function loadPlatformEnvFile(options: {
  env: NodeJS.ProcessEnv;
  repoRoot: string;
  platform?: NodeJS.Platform;
}): Promise<PlatformEnvFile | null> {
  const candidates = [
    applianceLayout(resolveApplianceRoot(options.env, options.platform)).envFilePath,
    path.join(options.repoRoot, ".env"),
  ];
  for (const candidate of candidates) {
    let raw: string;
    try {
      raw = await readFile(candidate, "utf8");
    } catch {
      continue;
    }
    return { path: candidate, values: parseEnvFile(raw) };
  }
  return null;
}
