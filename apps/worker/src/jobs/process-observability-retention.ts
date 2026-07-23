import {
  BUILT_IN_OBSERVABILITY_RETENTION_DAYS,
} from "@eveland/core/observability";
import type { Store } from "@eveland/db";

const dayMs = 24 * 60 * 60 * 1_000;

type RetentionStore = Pick<
  Store,
  | "pruneOtlpBatches"
  | "pruneDerivedAgentTelemetry"
  | "pruneHostMetrics"
>;

export function createObservabilityRetentionReconciler(input: {
  store: RetentionStore;
  now?: () => Date;
}): () => Promise<number> {
  const now = input.now ?? (() => new Date());
  let lastRunAt: number | undefined;
  let inFlight: Promise<number> | undefined;

  const reconcile = async (): Promise<number> => {
    const observedAt = now();
    if (
      lastRunAt !== undefined &&
      observedAt.getTime() - lastRunAt < dayMs
    ) {
      return 0;
    }

    const rawCutoffs = {
      tracesBefore: daysBefore(
        observedAt,
        BUILT_IN_OBSERVABILITY_RETENTION_DAYS.traces,
      ),
      logsBefore: daysBefore(
        observedAt,
        BUILT_IN_OBSERVABILITY_RETENTION_DAYS.logs,
      ),
      metricsBefore: daysBefore(
        observedAt,
        BUILT_IN_OBSERVABILITY_RETENTION_DAYS.metrics,
      ),
    };
    const [raw, derived, capacity] = await Promise.all([
      input.store.pruneOtlpBatches(rawCutoffs),
      input.store.pruneDerivedAgentTelemetry(
        daysBefore(
          observedAt,
          BUILT_IN_OBSERVABILITY_RETENTION_DAYS.sessions,
        ),
      ),
      input.store.pruneHostMetrics(
        daysBefore(
          observedAt,
          BUILT_IN_OBSERVABILITY_RETENTION_DAYS.capacity,
        ),
      ),
    ]);
    lastRunAt = observedAt.getTime();
    return (
      Object.values(raw).reduce((total, count) => total + count, 0) +
      Object.values(derived).reduce((total, count) => total + count, 0) +
      capacity
    );
  };

  return () => {
    if (inFlight) return inFlight;
    inFlight = reconcile().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}

function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * dayMs);
}
