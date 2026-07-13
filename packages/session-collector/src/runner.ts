import { randomUUID } from "node:crypto";
import { readFile, rename, rm } from "node:fs/promises";
import { isObserverEnvelopeRejectedError, type ObserverEnvelopeV1 } from "@eveland/core/observer";
import { claimReadyFile, quarantineFile, recoverExpiredClaims } from "./claims.js";
import { createCollectorHealth, type CollectorHealth } from "./health.js";
import { parseObserverEnvelope } from "./ingest.js";
import { listOutboxFiles } from "./outbox.js";

export type CollectorRuntimeOptions = {
  rootDir: string;
  ingest(envelope: ObserverEnvelopeV1): Promise<void>;
  collectorId?: string;
  intervalMs?: number;
  leaseAgeMs?: number;
  maxFileBytes?: number;
  maxBatchEvents?: number;
  maxBatchBytes?: number;
  maxRoundMs?: number;
  delayedAfterMs?: number;
  maxConcurrentSessions?: number;
  maxBacklogBytes?: number;
};

export type CollectorRuntime = {
  start(): void;
  stop(): Promise<void>;
  processOnce(): Promise<void>;
  getHealth(): CollectorHealth;
};

export function createCollectorRuntime(options: CollectorRuntimeOptions): CollectorRuntime {
  const collectorId = options.collectorId ?? randomUUID();
  const intervalMs = options.intervalMs ?? 1_000;
  const leaseAgeMs = options.leaseAgeMs ?? 60_000;
  const maxFileBytes = options.maxFileBytes ?? 1_048_576;
  const maxBatchEvents = options.maxBatchEvents ?? 100;
  const maxBatchBytes = options.maxBatchBytes ?? 10_485_760;
  const maxRoundMs = options.maxRoundMs ?? 5_000;
  const delayedAfterMs = options.delayedAfterMs ?? 30_000;
  const maxConcurrentSessions = options.maxConcurrentSessions ?? 100;
  const maxBacklogBytes = options.maxBacklogBytes ?? 1_073_741_824;
  const health = createCollectorHealth();
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let stopped = true;

  const processOnce = async (): Promise<void> => {
    const roundStartedAt = Date.now();
    await recoverExpiredClaims(options.rootDir, leaseAgeMs);
    const ready = await listOutboxFiles(options.rootDir, /\.ready\.json$/);
    let batchBytes = 0;
    let handled = 0;
    const handledSessions = new Set<string>();

    for (const file of ready) {
      if (handled >= maxBatchEvents || batchBytes + file.size > maxBatchBytes || Date.now() - roundStartedAt > maxRoundMs) break;
      const claimed = await claimReadyFile(file.path, collectorId);
      if (!claimed) continue;
      handled += 1;
      batchBytes += file.size;

      if (file.size > maxFileBytes) {
        await quarantineFile(options.rootDir, claimed);
        health.quarantinedEvents += 1;
        health.status = "degraded";
        health.lastError = `Observer envelope exceeds ${maxFileBytes} bytes: ${file.path}`;
        continue;
      }

      let envelope: ObserverEnvelopeV1;
      try {
        envelope = parseObserverEnvelope(await readFile(claimed, "utf8"));
      } catch (error) {
        await quarantineFile(options.rootDir, claimed);
        health.quarantinedEvents += 1;
        health.status = "degraded";
        health.lastError = errorMessage(error);
        continue;
      }

      if (!handledSessions.has(envelope.eveSessionId) && handledSessions.size >= maxConcurrentSessions) {
        await rename(claimed, claimed.replace(/\.processing\.[^.]+\.json$/, ".ready.json"));
        continue;
      }
      handledSessions.add(envelope.eveSessionId);

      try {
        await options.ingest(envelope);
        await rm(claimed);
        health.lastProcessedAt = new Date().toISOString();
        if (health.quarantinedEvents === 0) {
          health.status = "healthy";
          health.lastError = null;
        }
      } catch (error) {
        if (isObserverEnvelopeRejectedError(error)) {
          await quarantineFile(options.rootDir, claimed);
          health.quarantinedEvents += 1;
          health.status = "degraded";
          health.lastError = errorMessage(error);
          continue;
        }
        await rename(claimed, claimed.replace(/\.processing\.[^.]+\.json$/, ".ready.json"));
        health.status = "degraded";
        health.lastError = errorMessage(error);
        break;
      }
    }

    const backlog = await listOutboxFiles(options.rootDir, /\.ready\.json$/);
    health.backlogEvents = backlog.length;
    health.backlogBytes = backlog.reduce((total, file) => total + file.size, 0);
    health.oldestEventAge = backlog.length === 0 ? 0 : Math.max(0, Date.now() - Math.min(...backlog.map((file) => file.modifiedAtMs)));
    if (health.backlogBytes > maxBacklogBytes) {
      health.status = "degraded";
      health.lastError = `Observer backlog ${health.backlogBytes} bytes exceeds limit ${maxBacklogBytes} bytes.`;
    } else if (health.lastError?.startsWith("Observer backlog ")) {
      health.status = health.oldestEventAge > delayedAfterMs ? "delayed" : "healthy";
      health.lastError = null;
    } else if (health.status !== "degraded") {
      health.status = health.oldestEventAge > delayedAfterMs ? "delayed" : "healthy";
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      running = processOnce()
        .catch((error) => {
          health.status = "degraded";
          health.lastError = errorMessage(error);
        })
        .finally(() => {
          running = null;
          schedule();
        });
    }, intervalMs);
    timer.unref?.();
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      schedule();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await running;
    },
    processOnce,
    getHealth() {
      return { ...health };
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
