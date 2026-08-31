import { describe, expect, test } from "vitest";
import { createTestStore } from "@evelandhq/db/vitest";
import { collectInstanceHealth, probeGatewayHealth } from "./instance-health.js";

describe("instance health diagnostics", () => {
  test("probes the Gateway health endpoint without exposing internal credentials", async () => {
    const health = await probeGatewayHealth(
      { EVELAND_GATEWAY_INTERNAL_URL: "http://gateway:4080" },
      async (input) => {
        expect(String(input)).toBe("http://gateway:4080/health");
        return new Response(JSON.stringify({ ok: true, component: "gateway" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      () => new Date("2026-07-18T10:00:00.000Z"),
    );

    expect(health).toEqual({
      status: "healthy",
      message: "Agent Gateway health endpoint is reachable.",
      observedAt: "2026-07-18T10:00:00.000Z",
    });
  });

  test("combines component reachability, OTLP ingestion, host capacity, and workload", async () => {
    const store = createTestStore();
    await store.upsertWorkerHeartbeat({
      workerId: "worker-1",
      startedAt: "2026-07-18T08:00:00.000Z",
      observedAt: "2026-07-18T09:59:55.000Z",
      intervalMs: 5_000,
      lastTickDurationMs: 70,
      lastError: null,
      maxConcurrentHeavyJobs: 2,
    });
    await store.recordHostMetric({
      workerId: "worker-1",
      observedAt: "2026-07-18T09:59:30.000Z",
      cpuPercent: 32,
      load1: 0.7,
      memoryTotalBytes: 16_000,
      memoryAvailableBytes: 8_000,
      diskTotalBytes: 100_000,
      diskAvailableBytes: 60_000,
      diskInodesTotal: 10_000,
      diskInodesAvailable: 8_000,
      cpuCores: 4,
      pgConnections: [
        { role: "shared", usedConnections: 42, maxConnections: 100, agentPoolSize: 10 },
      ],
    });
    // The Collector is Built-in's only sender, so a recent batch is its liveness proof.
    await store.ingestOtlpBatch({
      signal: "metrics",
      payload: { resourceMetrics: [{ fresh: true }] },
    });

    const report = await collectInstanceHealth(store, {
      now: () => new Date("2026-07-18T10:00:00.000Z"),
      historyHours: 24,
      workflowWorkload: async () => null,
      gatewayHealth: async () => ({
        status: "healthy",
        message: "Gateway internal diagnostics are reachable.",
        observedAt: "2026-07-18T10:00:00.000Z",
      }),
    });

    expect(report.status).toBe("healthy");
    expect(report.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "api", status: "healthy" }),
        expect.objectContaining({ key: "postgres", status: "healthy" }),
        expect.objectContaining({ key: "gateway", status: "healthy" }),
        expect.objectContaining({ key: "worker", status: "healthy" }),
        expect.objectContaining({ key: "collector", status: "healthy" }),
      ]),
    );
    expect(report.capacity.overall).toBe("healthy");
    expect(report.metrics).toHaveLength(1);
    expect(report.workload.queuedJobs).toBe(0);
    // The cap lives on the worker's machine, so the report reads it from the
    // freshest heartbeat rather than the workload query.
    expect(report.workload.runningHeavyJobs).toBe(0);
    expect(report.workload.maxConcurrentHeavyJobs).toBe(2);
  });

  test("reports stale workers and unreachable Gateway without guessing healthy", async () => {
    const store = createTestStore();
    await store.upsertWorkerHeartbeat({
      workerId: "worker-1",
      startedAt: "2026-07-18T08:00:00.000Z",
      observedAt: "2026-07-18T09:55:00.000Z",
      intervalMs: 5_000,
      lastTickDurationMs: 70,
      lastError: null,
      maxConcurrentHeavyJobs: null,
    });

    const report = await collectInstanceHealth(store, {
      now: () => new Date("2026-07-18T10:00:00.000Z"),
      historyHours: 24,
      workflowWorkload: async () => null,
      gatewayHealth: async () => ({
        status: "unavailable",
        message: "Gateway diagnostics are unavailable.",
        observedAt: null,
      }),
    });

    expect(report.status).toBe("unavailable");
    expect(report.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "gateway", status: "unavailable" }),
        expect.objectContaining({ key: "worker", status: "unavailable" }),
      ]),
    );
  });

  test("marks the Collector unavailable when no batch has arrived recently", async () => {
    const store = createTestStore();
    // Receipts are stamped with defaultNow(), so staleness is produced by advancing
    // the observer's clock past the 90s threshold rather than by backdating the row.
    await store.ingestOtlpBatch({
      signal: "traces",
      payload: { resourceSpans: [] },
    });

    const report = await collectInstanceHealth(store, {
      now: () => new Date(Date.now() + 120_000),
      historyHours: 24,
      workflowWorkload: async () => null,
      gatewayHealth: async () => ({
        status: "healthy",
        message: "Gateway diagnostics are reachable.",
        observedAt: "2026-07-18T10:00:00.000Z",
      }),
    });

    expect(report.components).toContainEqual(
      expect.objectContaining({
        key: "collector",
        status: "unavailable",
        observedAt: expect.any(String),
      }),
    );
  });

  test("surfaces workflow dead-letter and quarantined-run counts as an alertable component", async () => {
    const store = createTestStore();

    const report = await collectInstanceHealth(store, {
      now: () => new Date("2026-07-18T10:00:00.000Z"),
      historyHours: 24,
      workflowWorkload: async () => ({
        pendingRuns: 12,
        runningRuns: 240,
        stuckRuns: 250,
        unresolvedDeadLetters: 9_530,
        oldestUnresolvedDeadLetterAt: "2026-07-01T00:00:00.000Z",
      }),
      gatewayHealth: async () => ({
        status: "healthy",
        message: "Gateway diagnostics are reachable.",
        observedAt: "2026-07-18T10:00:00.000Z",
      }),
    });

    expect(report.workflow).toEqual({
      pendingRuns: 12,
      runningRuns: 240,
      stuckRuns: 250,
      unresolvedDeadLetters: 9_530,
      oldestUnresolvedDeadLetterAt: "2026-07-01T00:00:00.000Z",
    });
    expect(report.components).toContainEqual({
      key: "workflow",
      label: "Workflow dispatch",
      status: "warning",
      message:
        "9530 unresolved dispatch dead letters and 250 quarantined workflow runs await operator resolution.",
      observedAt: "2026-07-18T10:00:00.000Z",
    });
  });

  test("omits the workflow component entirely when no world is configured", async () => {
    const store = createTestStore();

    const report = await collectInstanceHealth(store, {
      now: () => new Date("2026-07-18T10:00:00.000Z"),
      historyHours: 24,
      workflowWorkload: async () => null,
      gatewayHealth: async () => ({
        status: "healthy",
        message: "Gateway diagnostics are reachable.",
        observedAt: "2026-07-18T10:00:00.000Z",
      }),
    });

    expect(report.workflow).toBeNull();
    expect(report.components.map((component) => component.key)).not.toContain("workflow");
  });

  test("reports an unreadable workflow world unavailable instead of zeroed", async () => {
    const store = createTestStore();

    const report = await collectInstanceHealth(store, {
      now: () => new Date("2026-07-18T10:00:00.000Z"),
      historyHours: 24,
      workflowWorkload: async () => {
        throw new Error("connection refused");
      },
      gatewayHealth: async () => ({
        status: "healthy",
        message: "Gateway diagnostics are reachable.",
        observedAt: "2026-07-18T10:00:00.000Z",
      }),
    });

    expect(report.workflow).toBeNull();
    expect(report.components).toContainEqual(
      expect.objectContaining({ key: "workflow", status: "unavailable" }),
    );
    expect(report.status).toBe("unavailable");
  });

  test("warns when Built-in has never received a batch", async () => {
    const store = createTestStore();

    const report = await collectInstanceHealth(store, {
      now: () => new Date("2026-07-18T10:00:00.000Z"),
      historyHours: 24,
      workflowWorkload: async () => null,
      gatewayHealth: async () => ({
        status: "healthy",
        message: "Gateway diagnostics are reachable.",
        observedAt: "2026-07-18T10:00:00.000Z",
      }),
    });

    expect(report.components).toContainEqual(
      expect.objectContaining({
        key: "collector",
        status: "warning",
        observedAt: null,
      }),
    );
  });
});
