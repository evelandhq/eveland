import type { Store } from "@eveland/db";
import { collectHostMetric, type CpuTimes } from "./host-metrics.js";

type MetricCollector = typeof collectHostMetric;

export function createWorkerTelemetry(
  store: Store,
  options: {
    workerId: string;
    dataDir: string;
    intervalMs: number;
    metricIntervalMs: number;
    retentionMs: number;
    startedAt?: Date;
    now?: () => Date;
    collect?: MetricCollector;
    onMetricError?: (error: unknown) => void;
  },
) {
  const startedAt = options.startedAt ?? new Date();
  const now = options.now ?? (() => new Date());
  const collect = options.collect ?? collectHostMetric;
  let previousCpuTimes: CpuTimes | null = null;
  let lastMetricAt = Number.NEGATIVE_INFINITY;
  let lastPrunedAt = Number.NEGATIVE_INFINITY;
  let metricUnavailable = false;

  return {
    async publishTick(input: { durationMs: number; error: unknown | null }): Promise<void> {
      const observedAt = now();
      await store.upsertWorkerHeartbeat({
        workerId: options.workerId,
        startedAt: startedAt.toISOString(),
        observedAt: observedAt.toISOString(),
        intervalMs: options.intervalMs,
        lastTickDurationMs: Math.max(0, Math.round(input.durationMs)),
        lastError: input.error
          ? "Worker tick failed; inspect Worker logs."
          : metricUnavailable
            ? "Host capacity metrics are unavailable; inspect Worker logs."
            : null,
      });

      if (observedAt.getTime() - lastMetricAt < options.metricIntervalMs) return;
      try {
        const result = await collect(options.workerId, options.dataDir, previousCpuTimes);
        previousCpuTimes = result.cpuTimes;
        await store.recordHostMetric(result.sample);
        metricUnavailable = false;
        lastMetricAt = observedAt.getTime();
        if (observedAt.getTime() - lastPrunedAt >= 86_400_000) {
          await store.pruneHostMetrics(new Date(observedAt.getTime() - options.retentionMs));
          lastPrunedAt = observedAt.getTime();
        }
      } catch (error) {
        metricUnavailable = true;
        lastMetricAt = observedAt.getTime();
        options.onMetricError?.(error);
      }
    },
  };
}
