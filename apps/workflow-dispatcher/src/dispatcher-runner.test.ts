import { describe, expect, test, vi } from "vitest";
import type {
  DispatcherService,
  DispatcherServiceOptions,
} from "@evelandhq/workflow-world/dispatcher";
import { startEvelandWorkflowDispatcher, worldDatabaseIdentity } from "./dispatcher-runner.js";

const telemetry = { emit: vi.fn(), shutdown: vi.fn(async () => {}) };

function fakeServiceFactory(state: { phase: "ready_paused" | "ready" | "stopped" }) {
  const resume = vi.fn(async () => {
    state.phase = "ready";
    lifecycleSink?.({ phase: "ready", at: new Date() });
  });
  let lifecycleSink: ((event: { phase: string; at: Date }) => void) | undefined;
  const startService = vi.fn(async (options: DispatcherServiceOptions) => {
    lifecycleSink = options.lifecycle?.onPhase as typeof lifecycleSink;
    // Reproduce the package's ordering for a paused start.
    options.lifecycle?.onPhase?.({ phase: "ownership_acquired", at: new Date() });
    options.lifecycle?.onPhase?.({ phase: "migrations_applied", at: new Date() });
    await options.beforeBootRecovery?.({ pool: {} as never });
    options.lifecycle?.onPhase?.({
      phase: "boot_recovery_completed",
      at: new Date(),
      attributes: { reenqueuedRuns: 3 },
    });
    options.lifecycle?.onPhase?.({ phase: "ready_paused", at: new Date() });
    const service = {
      config: { worldUrl: "postgres://user:secret@db.internal:5432/eveland_workflow" },
      get phase() {
        return state.phase;
      },
      resume,
      stop: vi.fn(async () => {
        state.phase = "stopped";
      }),
    } as unknown as DispatcherService;
    return service;
  });
  return { startService, resume };
}

function runnerDeps(overrides: Record<string, unknown> = {}) {
  return {
    fetchImplementation: vi.fn(),
    countUnscopedJobs: vi.fn(async () => 0),
    countUnresolvedQuarantines: vi.fn(async () => 0),
    readSchemaGeneration: vi.fn(async () => "0013_run_quarantines.sql"),
    now: () => new Date("2026-08-18T00:00:00.000Z"),
    ...overrides,
  };
}

describe("eveland workflow dispatcher runner", () => {
  test("registers machine-readably without credentials and resumes only on the control plane's word", async () => {
    const state = { phase: "ready_paused" as const } as {
      phase: "ready_paused" | "ready" | "stopped";
    };
    const { startService, resume } = fakeServiceFactory(state);
    const heartbeats: Array<Record<string, unknown>> = [];
    let desiredState = "paused";
    const fetchImplementation = vi.fn(async (_url: string, init?: RequestInit) => {
      heartbeats.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ desiredState });
    });

    const handle = await startEvelandWorkflowDispatcher(
      {
        EVELAND_WORKFLOW_DISPATCHER_START_MODE: "recover-paused",
        WORKFLOW_DISPATCHER_ACTIVATION_API_URL: "http://control.test",
        WORKFLOW_DISPATCHER_ACTIVATION_TOKEN: "token",
      },
      telemetry,
      { ...runnerDeps({ fetchImplementation }), startService } as never,
    );

    // Paused start: the service was asked to pause and the first registration
    // reports a completed recovery that is not claiming.
    expect(startService).toHaveBeenCalledWith(expect.objectContaining({ startPaused: true }));
    expect(heartbeats[0]).toMatchObject({
      state: "ready_paused",
      ownershipAcquired: true,
      bootRecoveryCompleted: true,
      reenqueuedRuns: 3,
      unscopedRunnableJobs: 0,
      schemaGeneration: "0013_run_quarantines.sql",
      protocolMin: 1,
      protocolMax: 1,
      worldDatabaseIdentity: "db.internal:5432/eveland_workflow",
    });
    // The identity never carries the URL or its credentials.
    expect(JSON.stringify(heartbeats[0])).not.toContain("postgres://");
    expect(JSON.stringify(heartbeats[0])).not.toContain("secret");
    // A "paused" reply does not resume.
    expect(resume).not.toHaveBeenCalled();

    // The authenticated resume arrives through the heartbeat reply.
    desiredState = "ready";
    await handle.heartbeat();
    expect(resume).toHaveBeenCalledTimes(1);
    // Once ready, further ready replies are a no-op.
    await handle.heartbeat();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(heartbeats.at(-1)).toMatchObject({ state: "ready" });
  });

  test("fails startup closed while early-external jobs are still claimable", async () => {
    const state = { phase: "ready_paused" as const } as {
      phase: "ready_paused" | "ready" | "stopped";
    };
    const { startService } = fakeServiceFactory(state);

    await expect(
      startEvelandWorkflowDispatcher({}, telemetry, {
        ...runnerDeps({ countUnscopedJobs: vi.fn(async () => 7) }),
        startService,
      } as never),
    ).rejects.toThrow(/7 early-external job/);
  });

  test("a failed heartbeat is reported, never fatal", async () => {
    const state = { phase: "ready_paused" as const } as {
      phase: "ready_paused" | "ready" | "stopped";
    };
    const { startService } = fakeServiceFactory(state);
    const fetchImplementation = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    const handle = await startEvelandWorkflowDispatcher(
      { WORKFLOW_DISPATCHER_ACTIVATION_API_URL: "http://control.test" },
      telemetry,
      { ...runnerDeps({ fetchImplementation }), startService } as never,
    );
    await expect(handle.heartbeat()).resolves.toBeUndefined();
    expect(telemetry.emit).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: "workflow_dispatcher.heartbeat_failed" }),
    );
  });
});

describe("worldDatabaseIdentity", () => {
  test("keeps host, port and database; drops credentials", () => {
    expect(worldDatabaseIdentity("postgres://user:secret@db:6432/wf")).toBe("db:6432/wf");
    expect(worldDatabaseIdentity("postgres://db/wf")).toBe("db:5432/wf");
    expect(worldDatabaseIdentity("not a url")).toBe("unknown");
  });
});
