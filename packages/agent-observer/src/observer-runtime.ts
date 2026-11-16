import { createPolicyManagedAgentTelemetry } from "./policy-runtime.js";
import { modelCallCapture } from "./runtime/model-capture.js";
import type { AgentTelemetryEvent, AgentTelemetryHookContext } from "./runtime.js";

/**
 * The plain configurations the observer hands eve, deliberately NOT wrapped in
 * `defineHook` / `defineInstrumentation`: the runtime is bundled fully
 * self-contained so the Worker can deliver the current build into the
 * observability mount of every deployment, where the Agent's `eve` package is
 * not resolvable. The shims baked into each release import the helpers from
 * the Agent's own eve installation and wrap these values.
 */
export type ObserverRuntime = {
  /** A `*` hook: the session stream's facts, exported as the Agent's telemetry. */
  hook: {
    events: {
      "*"(event: AgentTelemetryEvent, context: AgentTelemetryHookContext): Promise<void>;
    };
  };
  /** Lifecycle instrumentation: the model each provider call actually ran. */
  instrumentation: {
    tracePolicy(): { emit: true; recordInputs: false; recordOutputs: false };
    events: {
      "model.call.started"(event: unknown): void;
      "model.call.settled"(event: unknown): void;
    };
  };
};

export function createObserverRuntime(input: {
  loadPolicy: () => Promise<unknown>;
}): ObserverRuntime {
  let lastWarningAt = 0;
  const warnRateLimited = (error: unknown): void => {
    const now = Date.now();
    if (now - lastWarningAt < 60_000) return;
    lastWarningAt = now;
    console.warn(
      "[eveland-observer] telemetry degraded:",
      error instanceof Error ? error.message : String(error),
    );
  };
  const telemetry = createPolicyManagedAgentTelemetry({
    loadPolicy: input.loadPolicy,
    warn: warnRateLimited,
  });

  return {
    hook: {
      events: {
        // An unhandled hook error fails the running turn, so this handler must
        // never throw: telemetry failure may never fail an Agent turn.
        // `capture` and `forceFlush` already swallow their own errors; the
        // outer guard keeps that true for anything they might miss.
        async "*"(event, context) {
          try {
            await telemetry.capture(event, context);
            if (event.type === "session.ended") await telemetry.forceFlush();
          } catch (error) {
            warnRateLimited(error);
          }
        },
      },
    },
    instrumentation: {
      // eve records model call content for every AI SDK telemetry integration
      // in the process when any instrumentation file asks for it. The observer
      // needs only model ids, so it asks for none and never widens what the
      // Agent's own integrations receive.
      tracePolicy: () => ({ emit: true, recordInputs: false, recordOutputs: false }),
      events: {
        "model.call.started": (event) => modelCallCapture.observe(event),
        "model.call.settled": (event) => modelCallCapture.observe(event),
      },
    },
  };
}
