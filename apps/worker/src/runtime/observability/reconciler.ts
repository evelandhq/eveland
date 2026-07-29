export type WorkerObservabilityReconciler = {
  name: string;
  run: () => Promise<unknown>;
};

export function createWorkerObservabilityReconciler(
  reconcilers: WorkerObservabilityReconciler[],
  options: {
    now?: () => number;
    warningIntervalMs?: number;
    warn?: (message: string, error: unknown) => void;
  } = {},
): () => Promise<void> {
  const now = options.now ?? Date.now;
  const warningIntervalMs = options.warningIntervalMs ?? 60_000;
  const warn =
    options.warn ??
    ((message, error) =>
      console.warn(
        message,
        error instanceof Error ? error.message : String(error),
      ));
  const lastWarningAt = new Map<string, number>();

  return async () => {
    await Promise.all(
      reconcilers.map(async (reconciler) => {
        try {
          await reconciler.run();
        } catch (error) {
          const warningAt = now();
          const previousWarningAt = lastWarningAt.get(reconciler.name);
          if (
            previousWarningAt !== undefined &&
            warningAt - previousWarningAt < warningIntervalMs
          ) {
            return;
          }
          lastWarningAt.set(reconciler.name, warningAt);
          warn(`${reconciler.name} reconciliation is degraded:`, error);
        }
      }),
    );
  };
}
