import type { Store } from "@eveland/db";
import { rm } from "node:fs/promises";
import path from "node:path";

import { scanEveSource } from "../source/scan.js";
import { runWithJobHeartbeat } from "./process.js";
import { errorMessage } from "./process-support.js";
import type { ProcessJobOptions } from "./process-types.js";
import { materializeGitSource } from "./source-materialize.js";

// The narrow persistence port the preflight pipeline actually needs.
type SourcePreflightStore = Pick<
  Store,
  | "claimNextSourcePreflight"
  | "heartbeatSourcePreflight"
  | "completeSourcePreflight"
  | "failSourcePreflight"
  | "expireSourcePreflights"
>;

export async function processNextSourcePreflight(
  store: SourcePreflightStore,
  workerId: string,
  options: ProcessJobOptions = {},
): Promise<boolean> {
  const preflight = await store.claimNextSourcePreflight(workerId);
  if (!preflight) return false;
  let managedAttemptDir: string | null = null;

  try {
    await runWithJobHeartbeat({
      intervalMs:
        options.jobHeartbeatIntervalMs ??
        Number(process.env.WORKER_JOB_HEARTBEAT_INTERVAL_MS ?? 30_000),
      heartbeat: () => store.heartbeatSourcePreflight(preflight.id, preflight.attempts),
      work: async (signal) => {
        let sourcePath = preflight.sourcePath;
        let commitSha = preflight.commitSha;
        if (!sourcePath && preflight.kind === "git") {
          if (!preflight.gitUrl) throw new Error("Git preflight missing gitUrl.");
          managedAttemptDir = path.join(
            options.dataDir ?? process.env.EVELAND_DATA_DIR ?? ".eveland-data",
            "preflights",
            preflight.id,
            `attempt-${preflight.attempts}`,
          );
          sourcePath = path.join(managedAttemptDir, "source");
          commitSha = await materializeGitSource({
            gitUrl: preflight.gitUrl,
            targetDir: sourcePath,
            credential: preflight.gitCredential,
            appSecretKey: options.appSecretKey,
            signal,
          });
        }
        if (!sourcePath) throw new Error("Source preflight missing sourcePath.");

        signal.throwIfAborted();
        const scan = await scanEveSource({ kind: preflight.kind, sourcePath, commitSha });
        signal.throwIfAborted();
        const completed = await store.completeSourcePreflight(preflight.id, preflight.attempts, {
          sourcePath,
          commitSha,
          summary: scan.summary,
        });
        if (!completed) throw new Error(`Source preflight ${preflight.id} lost its worker lease.`);
      },
    });
    return true;
  } catch (error) {
    if (managedAttemptDir) await rm(managedAttemptDir, { recursive: true, force: true });
    await store.failSourcePreflight(preflight.id, preflight.attempts, errorMessage(error));
    return true;
  }
}

export async function cleanupExpiredSourcePreflights(
  store: SourcePreflightStore,
  dataDir = process.env.EVELAND_DATA_DIR ?? ".eveland-data",
  now = new Date(),
): Promise<number> {
  const paths = await store.expireSourcePreflights(now, 25);
  const root = path.resolve(dataDir);
  let removed = 0;
  for (const sourcePath of paths) {
    const resolved = path.resolve(sourcePath);
    if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) continue;
    let cleanupTarget = resolved;
    for (let cursor = resolved; cursor !== root; cursor = path.dirname(cursor)) {
      const name = path.basename(cursor);
      if (name.startsWith("zip-") || name.startsWith("pre_")) {
        cleanupTarget = cursor;
        break;
      }
      if (path.dirname(cursor) === cursor) break;
    }
    await rm(cleanupTarget, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
