import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { listOutboxFiles } from "./outbox.js";

export async function claimReadyFile(readyPath: string, collectorId: string): Promise<string | null> {
  const processingPath = readyPath.replace(/\.ready\.json$/, `.processing.${safeSegment(collectorId)}.json`);
  try {
    await rename(readyPath, processingPath);
    return processingPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function recoverExpiredClaims(root: string, leaseAgeMs: number, now = Date.now()): Promise<number> {
  const processing = await listOutboxFiles(root, /\.processing\.[^.]+\.json$/);
  let recovered = 0;
  for (const file of processing) {
    if (now - file.modifiedAtMs < leaseAgeMs) continue;
    await rename(file.path, file.path.replace(/\.processing\.[^.]+\.json$/, ".ready.json"));
    recovered += 1;
  }
  return recovered;
}

export async function quarantineFile(root: string, filePath: string): Promise<string> {
  const quarantineDir = path.join(path.resolve(root), "quarantine");
  await mkdir(quarantineDir, { recursive: true });
  const target = path.join(quarantineDir, `${path.basename(filePath)}.${Date.now()}.bad.json`);
  await rename(filePath, target);
  return target;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}
