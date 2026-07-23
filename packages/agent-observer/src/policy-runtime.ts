import { agentRuntimePolicySchema } from "@eveland/core/observability";
import {
  createPrivateAgentTelemetryRuntime,
  type AgentTelemetryEvent,
  type AgentTelemetryHookContext,
  type PrivateAgentTelemetryRuntime,
  type RuntimeAgentPolicy,
} from "./runtime.js";

export type PolicyManagedAgentTelemetry = {
  capture(
    event: AgentTelemetryEvent,
    context: AgentTelemetryHookContext,
  ): Promise<void>;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
};

export function createPolicyManagedAgentTelemetry(input: {
  loadPolicy: () => Promise<unknown>;
  refreshIntervalMillis?: number;
  now?: () => number;
  createRuntime?: (input: {
    policy: RuntimeAgentPolicy;
  }) => PrivateAgentTelemetryRuntime;
  warn?: (error: unknown) => void;
}): PolicyManagedAgentTelemetry {
  const refreshIntervalMillis = input.refreshIntervalMillis ?? 5_000;
  const now = input.now ?? Date.now;
  const createRuntime =
    input.createRuntime ??
    ((runtimeInput) =>
      createPrivateAgentTelemetryRuntime({
        policy: runtimeInput.policy,
        warn: input.warn,
      }));
  let active:
    | {
        policy: RuntimeAgentPolicy;
        runtime: PrivateAgentTelemetryRuntime;
      }
    | undefined;
  let nextRefreshAt = 0;
  let refreshPromise: Promise<void> | undefined;
  let stopped = false;

  async function capture(
    event: AgentTelemetryEvent,
    context: AgentTelemetryHookContext,
  ): Promise<void> {
    if (stopped) return;
    await refreshIfDue();
    try {
      await active?.runtime.capture(event, context);
    } catch (error) {
      input.warn?.(error);
    }
  }

  async function refreshIfDue(): Promise<void> {
    if (refreshPromise) {
      await refreshPromise;
      return;
    }
    if (now() < nextRefreshAt) return;
    nextRefreshAt = now() + refreshIntervalMillis;
    refreshPromise ??= reload().finally(() => {
      refreshPromise = undefined;
    });
    await refreshPromise;
  }

  async function reload(): Promise<void> {
    try {
      const parsed = agentRuntimePolicySchema.safeParse(
        await input.loadPolicy(),
      );
      if (!parsed.success) {
        throw new Error(
          `Invalid Agent observability policy: ${parsed.error.issues
            .map((issue) => issue.message)
            .join("; ")}`,
        );
      }
      const policy = parsed.data;
      if (!policy.capture.enabled) {
        await disable();
        return;
      }
      if (active?.policy.revision === policy.revision) return;

      const nextRuntime = createRuntime({ policy });
      const previous = active;
      active = { policy, runtime: nextRuntime };
      await previous?.runtime.shutdown();
    } catch (error) {
      await disable();
      input.warn?.(error);
    }
  }

  async function disable(): Promise<void> {
    const previous = active;
    active = undefined;
    await previous?.runtime.shutdown();
  }

  async function forceFlush(): Promise<void> {
    if (stopped) return;
    try {
      await active?.runtime.forceFlush();
    } catch (error) {
      input.warn?.(error);
    }
  }

  async function shutdown(): Promise<void> {
    if (stopped) return;
    stopped = true;
    await disable();
  }

  return { capture, forceFlush, shutdown };
}
