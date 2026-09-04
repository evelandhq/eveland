import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConfigurationSnapshot, EvelandComponent } from "../config-diagnostics.js";

export async function writeConfigurationSnapshotFile(
  dataDir: string,
  snapshot: ConfigurationSnapshot,
): Promise<string> {
  const directory = path.resolve(dataDir, "diagnostics");
  const destination = snapshotFilePath(dataDir, snapshot.component);
  const temporary = path.join(
    directory,
    `.${snapshot.component}-configuration-${randomUUID()}.tmp`,
  );
  // 0750/0640 rather than 0700/0600: the writer and the reader are different
  // identities in the production form — the worker publishes this as root and
  // the API reads it as the unprivileged platform user — and a shared group is
  // how they meet without it becoming world-readable. `mkdir` leaves an
  // existing directory's mode alone, so an installation that sets the setgid
  // bit (eveland-ctl does) keeps it.
  await mkdir(directory, { recursive: true, mode: 0o750 });
  try {
    await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8", mode: 0o640 });
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return destination;
}

export async function readConfigurationSnapshotFile(
  dataDir: string,
  component: EvelandComponent,
): Promise<ConfigurationSnapshot | null> {
  let contents: string;
  try {
    contents = await readFile(snapshotFilePath(dataDir, component), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(contents) as unknown;
  if (!isConfigurationSnapshot(parsed, component))
    throw new Error(`Invalid ${component} configuration snapshot.`);
  return parsed;
}

function snapshotFilePath(dataDir: string, component: EvelandComponent): string {
  return path.resolve(dataDir, "diagnostics", `${component}-configuration.json`);
}

function isConfigurationSnapshot(
  value: unknown,
  component: EvelandComponent,
): value is ConfigurationSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ConfigurationSnapshot>;
  return (
    candidate.component === component &&
    typeof candidate.observedAt === "string" &&
    Array.isArray(candidate.entries)
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
