import { asRecord, asString } from "./values.js";

/**
 * The model a run's provider call actually ran. The stream's `model.started`
 * names the model eve selected for the run (a reference such as
 * `anthropic/claude-sonnet-5`); the provider that resolves that reference can
 * run a different id, which eve reports only on its instrumentation events
 * (`model.call.started.model.modelId`). `responseModelId` is the id the
 * provider echoed back for the response.
 */
export type ObservedModelCall = {
  modelId: string;
  responseModelId?: string;
};

export type ModelRun = { sessionId: string; runId: string };

export type ModelCallCapture = {
  /** Records one `model.call.started` or `model.call.settled` instrumentation event. */
  observe(event: unknown): void;
  /** The model the run's latest provider call ran, if one was observed. */
  take(run: ModelRun): ObservedModelCall | undefined;
};

/**
 * Runs recorded before their `usage.recorded` arrives. A run's usage follows
 * its provider call within the same step, so only the runs in flight across
 * the process's concurrent sessions are live; older entries belong to runs
 * whose usage was already taken or never came.
 */
const defaultMaxRuns = 256;

/**
 * Correlates eve's instrumentation `model.call.*` events with the session
 * stream's `usage.recorded` by the run they share. eve gives every session
 * its own run ids (`run_0`, `run_1`, ...), so the key is the session and the
 * run. Instrumentation is root-only in eve and reports every session the
 * process runs, subagents included, so one capture serves the root hook and
 * every subagent hook in the process. `observe` runs on eve's instrumentation
 * bus and must never throw.
 */
export function createModelCallCapture(options: { maxRuns?: number } = {}): ModelCallCapture {
  const maxRuns = Math.max(1, options.maxRuns ?? defaultMaxRuns);
  const runs = new Map<string, ObservedModelCall>();

  function remember(key: string, observed: ObservedModelCall): void {
    runs.delete(key);
    runs.set(key, observed);
    while (runs.size > maxRuns) {
      const oldest = runs.keys().next().value;
      if (oldest === undefined) break;
      runs.delete(oldest);
    }
  }

  return {
    observe(event: unknown): void {
      try {
        const record = asRecord(event);
        const scope = asRecord(record?.scope);
        const sessionId = asString(scope?.sessionId);
        const runId = asString(scope?.runId);
        if (!sessionId || !runId) return;
        const key = runKey({ sessionId, runId });
        if (record?.type === "model.call.started") {
          const modelId = asString(asRecord(record.model)?.modelId);
          if (modelId) remember(key, { modelId });
          return;
        }
        if (record?.type === "model.call.settled" && record.outcome === "completed") {
          const responseModelId = asString(record.responseModelId);
          const started = runs.get(key);
          if (started && responseModelId) remember(key, { ...started, responseModelId });
        }
      } catch {
        // Never propagate into eve's instrumentation dispatch.
      }
    },
    take(run: ModelRun): ObservedModelCall | undefined {
      const observed = runs.get(runKey(run));
      return observed ? { ...observed } : undefined;
    },
  };
}

function runKey(run: ModelRun): string {
  return `${run.sessionId}\0${run.runId}`;
}

/** The process-wide capture the observer runtime's hook and instrumentation share. */
export const modelCallCapture: ModelCallCapture = createModelCallCapture();
