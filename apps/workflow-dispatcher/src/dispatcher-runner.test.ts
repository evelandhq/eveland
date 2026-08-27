import { describe, expect, test, vi } from "vitest";
import type {
  DispatcherService,
  DispatcherServiceOptions,
} from "@evelandhq/workflow-world/dispatcher";
import { startEvelandWorkflowDispatcher } from "./dispatcher-runner.js";

const telemetry = { emit: vi.fn(), shutdown: vi.fn(async () => {}) };

function fakeServiceFactory(state: { phase: "ready" | "stopped" }) {
  const startService = vi.fn(async (options: DispatcherServiceOptions) => {
    // Reproduce the package's lifecycle ordering.
    options.lifecycle?.onPhase?.({ phase: "ownership_acquired", at: new Date() });
    options.lifecycle?.onPhase?.({ phase: "migrations_applied", at: new Date() });
    await options.beforeBootRecovery?.({ pool: {} as never });
    options.lifecycle?.onPhase?.({
      phase: "boot_recovery_completed",
      at: new Date(),
      attributes: { reenqueuedRuns: 3 },
    });
    options.lifecycle?.onPhase?.({ phase: "ready", at: new Date() });
    const service = {
      config: { worldUrl: "postgres://user:secret@db.internal:5432/eveland_workflow" },
      get phase() {
        return state.phase;
      },
      stop: vi.fn(async () => {
        state.phase = "stopped";
      }),
    } as unknown as DispatcherService;
    return service;
  });
  return { startService };
}

function runnerDeps(overrides: Record<string, unknown> = {}) {
  return {
    fetchImplementation: vi.fn(),
    readSchemaGeneration: vi.fn(async () => "0013_run_quarantines.sql"),
    readWorldIdentity: vi.fn(async () => "cluster:7234567890123456789/eveland_workflow"),
    now: () => new Date("2026-08-18T00:00:00.000Z"),
    ...overrides,
  };
}

describe("eveland workflow dispatcher runner", () => {
  test("exports per-tenant saturation with every heartbeat", async () => {
    const state = { phase: "ready" as const } as { phase: "ready" | "stopped" };
    const { startService: baseStartService } = fakeServiceFactory(state);
    const startService = vi.fn(async (options: DispatcherServiceOptions) => {
      const service = await baseStartService(options);
      return {
        ...service,
        config: {
          ...service.config,
          concurrency: 8,
          maxInFlightPerTenant: 2,
        },
        runtime: {
          fairness: {
            snapshot: () => ({ p_saturated: 2, p_active: 1 }),
          },
        },
      } as unknown as DispatcherService;
    });
    const capacityTelemetry = { emit: vi.fn(), shutdown: vi.fn(async () => {}) };
    const fetchImplementation = vi.fn(async () => Response.json({ registration: {} }));

    await startEvelandWorkflowDispatcher(
      { WORKFLOW_DISPATCHER_ACTIVATION_API_URL: "http://control.test" },
      capacityTelemetry,
      { ...runnerDeps({ fetchImplementation }), startService } as never,
    );

    expect(capacityTelemetry.emit).toHaveBeenCalledWith({
      severity: "info",
      eventName: "workflow_dispatcher.capacity",
      body: "workflow dispatcher capacity snapshot",
      attributes: {
        "dispatcher.in_flight": 3,
        "dispatcher.concurrency": 8,
        "dispatcher.available": 5,
        "dispatcher.max_in_flight_per_tenant": 2,
        "dispatcher.saturated_tenants": 1,
      },
    });
    expect(capacityTelemetry.emit).toHaveBeenCalledWith({
      severity: "warn",
      eventName: "workflow_dispatcher.tenant_saturated",
      body: "tenant reached the workflow dispatcher in-flight cap",
      attributes: {
        "eveland.project.id": "p_saturated",
        "dispatcher.tenant.in_flight": 2,
        "dispatcher.max_in_flight_per_tenant": 2,
        "dispatcher.in_flight": 3,
        "dispatcher.concurrency": 8,
      },
    });
  });

  test("registers machine-readably without credentials", async () => {
    const state = { phase: "ready" as const } as { phase: "ready" | "stopped" };
    const { startService } = fakeServiceFactory(state);
    const heartbeats: Array<Record<string, unknown>> = [];
    const fetchImplementation = vi.fn(async (_url: string, init?: RequestInit) => {
      heartbeats.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ registration: {} });
    });

    const handle = await startEvelandWorkflowDispatcher(
      {
        WORKFLOW_DISPATCHER_ACTIVATION_API_URL: "http://control.test",
        WORKFLOW_DISPATCHER_ACTIVATION_TOKEN: "token",
      },
      telemetry,
      { ...runnerDeps({ fetchImplementation }), startService } as never,
    );

    expect(heartbeats[0]).toMatchObject({
      state: "ready",
      ownershipAcquired: true,
      bootRecoveryCompleted: true,
      reenqueuedRuns: 3,
      schemaGeneration: "0013_run_quarantines.sql",
      protocolMin: 1,
      protocolMax: 1,
      worldDatabaseIdentity: "cluster:7234567890123456789/eveland_workflow",
    });
    // The identity never carries the URL or its credentials.
    expect(JSON.stringify(heartbeats[0])).not.toContain("postgres://");
    expect(JSON.stringify(heartbeats[0])).not.toContain("secret");

    await handle.stop();
    expect(heartbeats.at(-1)).toMatchObject({ state: "stopped" });
  });

  test("a failed heartbeat is reported, never fatal", async () => {
    const state = { phase: "ready" as const } as { phase: "ready" | "stopped" };
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
