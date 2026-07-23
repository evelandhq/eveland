import { describe, expect, test, vi } from "vitest";
import {
  createPolicyManagedAgentTelemetry,
  type PolicyManagedAgentTelemetry,
} from "./policy-runtime.js";
import type {
  AgentTelemetryEvent,
  AgentTelemetryHookContext,
  PrivateAgentTelemetryRuntime,
  RuntimeAgentPolicy,
} from "./runtime.js";

describe("policy-managed Agent telemetry", () => {
  test("reloads a new revision without environment variables or an Agent restart", async () => {
    let now = 0;
    let currentPolicy = policy(1);
    const loadPolicy = vi.fn(async () => currentPolicy);
    const created: Array<{
      policy: RuntimeAgentPolicy;
      capture: ReturnType<typeof vi.fn>;
      shutdown: ReturnType<typeof vi.fn>;
    }> = [];
    const managed = createManaged({
      now: () => now,
      loadPolicy,
      createRuntime: ({ policy: loadedPolicy }) => {
        const capture = vi.fn(async () => undefined);
        const shutdown = vi.fn(async () => undefined);
        created.push({ policy: loadedPolicy, capture, shutdown });
        return fakeRuntime(capture, shutdown);
      },
    });

    await managed.capture(event(), context());
    now = 4_999;
    await managed.capture(event(), context());
    expect(loadPolicy).toHaveBeenCalledOnce();
    expect(created).toHaveLength(1);
    expect(created[0]?.capture).toHaveBeenCalledTimes(2);

    currentPolicy = policy(2);
    now = 5_000;
    await managed.capture(event(), context());

    expect(loadPolicy).toHaveBeenCalledTimes(2);
    expect(created.map((entry) => entry.policy.revision)).toEqual([1, 2]);
    expect(created[0]?.shutdown).toHaveBeenCalledOnce();
    expect(created[1]?.capture).toHaveBeenCalledOnce();
    await managed.shutdown();
  });

  test("waits for an in-flight privacy refresh before capturing the next event", async () => {
    let resolveReload: ((policy: RuntimeAgentPolicy) => void) | undefined;
    let now = 0;
    const first = fakeRuntime(
      vi.fn(async () => undefined),
      vi.fn(async () => undefined),
    );
    const secondCapture = vi.fn(async () => undefined);
    const second = fakeRuntime(
      secondCapture,
      vi.fn(async () => undefined),
    );
    let loadCount = 0;
    const managed = createManaged({
      now: () => now,
      loadPolicy: async () => {
        loadCount += 1;
        if (loadCount === 1) return policy(1);
        return await new Promise<RuntimeAgentPolicy>((resolve) => {
          resolveReload = resolve;
        });
      },
      createRuntime: ({ policy: loadedPolicy }) =>
        loadedPolicy.revision === 1 ? first : second,
    });

    await managed.capture(event(), context());
    now = 5_000;
    const refreshingCapture = managed.capture(event(), context());
    const concurrentCapture = managed.capture(event(), context());
    resolveReload?.(policy(2));
    await Promise.all([refreshingCapture, concurrentCapture]);

    expect(secondCapture).toHaveBeenCalledTimes(2);
    await managed.shutdown();
  });

  test("disables only Eveland telemetry when policy is missing, invalid, or disabled", async () => {
    const warn = vi.fn();
    const createRuntime = vi.fn();
    const policies: unknown[] = [
      new Error("missing"),
      { schemaVersion: 1, revision: 1 },
      policy(2, false),
    ];
    let now = 0;
    const managed = createManaged({
      now: () => now,
      warn,
      loadPolicy: async () => {
        const next = policies.shift();
        if (next instanceof Error) throw next;
        return next;
      },
      createRuntime,
    });

    await expect(managed.capture(event(), context())).resolves.toBeUndefined();
    now = 5_000;
    await expect(managed.capture(event(), context())).resolves.toBeUndefined();
    now = 10_000;
    await expect(managed.capture(event(), context())).resolves.toBeUndefined();

    expect(createRuntime).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
    await managed.shutdown();
  });
});

function createManaged(
  input: Parameters<typeof createPolicyManagedAgentTelemetry>[0],
): PolicyManagedAgentTelemetry {
  return createPolicyManagedAgentTelemetry({
    refreshIntervalMillis: 5_000,
    ...input,
  });
}

function fakeRuntime(
  capture: (
    event: AgentTelemetryEvent,
    context: AgentTelemetryHookContext,
  ) => Promise<void>,
  shutdown: () => Promise<void>,
): PrivateAgentTelemetryRuntime {
  return {
    capture,
    forceFlush: async () => undefined,
    shutdown,
  };
}

function policy(revision: number, enabled = true): RuntimeAgentPolicy {
  return {
    schemaVersion: 1,
    revision,
    capture: {
      enabled,
      sampleRatio: 1,
      recordInputs: false,
      recordOutputs: false,
      includeReasoning: false,
    },
    otlp: { endpoint: "http://127.0.0.1:4318" },
    resource: {
      teamId: "team_1",
      projectId: "proj_1",
      releaseId: "rel_1",
      deploymentId: "dep_1",
      runtimeKind: "systemd",
      environment: "production",
    },
  };
}

function event(): AgentTelemetryEvent {
  return {
    type: "turn.started",
    data: { turnId: "turn_1", sequence: 1 },
  };
}

function context(): AgentTelemetryHookContext {
  return {
    session: { id: "eve_session_1" },
    agent: { name: "Researcher" },
    channel: { kind: "http" },
  };
}
