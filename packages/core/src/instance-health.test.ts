import { describe, expect, test } from "vitest";
import {
  analyzeHostCapacity,
  summarizeWorkerHealth,
  type HostMetricSample,
} from "./instance-health.js";

const gibibyte = 1024 ** 3;

function sample(observedAt: string, overrides: Partial<HostMetricSample> = {}): HostMetricSample {
  return {
    id: `metric-${observedAt}`,
    workerId: "worker-1",
    observedAt,
    cpuPercent: 24,
    load1: 0.8,
    memoryTotalBytes: 16 * gibibyte,
    memoryAvailableBytes: 10 * gibibyte,
    diskTotalBytes: 200 * gibibyte,
    diskAvailableBytes: 120 * gibibyte,
    diskInodesTotal: 1_000_000,
    diskInodesAvailable: 800_000,
    cpuCores: 4,
    pgConnections: null,
    ...overrides,
  };
}

describe("instance health analysis", () => {
  test("marks a fresh worker heartbeat healthy", () => {
    const health = summarizeWorkerHealth(
      {
        workerId: "worker-1",
        startedAt: "2026-07-18T08:00:00.000Z",
        observedAt: "2026-07-18T09:59:30.000Z",
        intervalMs: 5_000,
        lastTickDurationMs: 81,
        lastError: null,
      },
      new Date("2026-07-18T10:00:00.000Z"),
    );

    expect(health).toEqual({
      status: "healthy",
      message: "Worker heartbeat is current.",
      observedAt: "2026-07-18T09:59:30.000Z",
    });
  });

  test("marks a stale worker heartbeat unavailable", () => {
    const health = summarizeWorkerHealth(
      {
        workerId: "worker-1",
        startedAt: "2026-07-18T08:00:00.000Z",
        observedAt: "2026-07-18T09:57:59.000Z",
        intervalMs: 5_000,
        lastTickDurationMs: 81,
        lastError: null,
      },
      new Date("2026-07-18T10:00:00.000Z"),
    );

    expect(health.status).toBe("unavailable");
    expect(health.message).toContain("heartbeat is stale");
  });

  test("warns before disk exhaustion by using recent growth", () => {
    const analysis = analyzeHostCapacity([
      sample("2026-07-11T10:00:00.000Z", {
        diskAvailableBytes: 38 * gibibyte,
      }),
      sample("2026-07-18T10:00:00.000Z", {
        diskAvailableBytes: 24 * gibibyte,
      }),
    ]);

    expect(analysis.disk.usedPercent).toBe(88);
    expect(analysis.disk.projectedDaysRemaining).toBe(12);
    expect(analysis.risks).toContainEqual(
      expect.objectContaining({
        code: "disk_projected_exhaustion",
        severity: "warning",
      }),
    );
  });

  test("treats critically low memory and inode headroom as actionable risks", () => {
    const analysis = analyzeHostCapacity([
      sample("2026-07-18T10:00:00.000Z", {
        memoryAvailableBytes: 512 * 1024 ** 2,
        diskInodesAvailable: 30_000,
      }),
    ]);

    expect(analysis.overall).toBe("critical");
    expect(analysis.risks.map((risk) => risk.code)).toEqual(
      expect.arrayContaining(["memory_available", "disk_inodes"]),
    );
  });

  test("does not invent a disk forecast without enough history", () => {
    const analysis = analyzeHostCapacity([sample("2026-07-18T10:00:00.000Z")]);

    expect(analysis.disk.projectedDaysRemaining).toBeNull();
    expect(analysis.risks).toEqual([]);
    expect(analysis.overall).toBe("healthy");
  });

  test("exposes the machine's totals so headroom percentages have a denominator", () => {
    const analysis = analyzeHostCapacity([sample("2026-07-18T10:00:00.000Z")]);

    expect(analysis.memory.totalBytes).toBe(16 * gibibyte);
    expect(analysis.disk.totalBytes).toBe(200 * gibibyte);
    expect(analysis.cpu.cores).toBe(4);
  });

  test("reports null totals when metrics predate the spec fields", () => {
    const analysis = analyzeHostCapacity([
      sample("2026-07-18T10:00:00.000Z", { cpuCores: null, pgConnections: null }),
    ]);

    expect(analysis.cpu.cores).toBeNull();
    expect(analysis.postgres.instances).toEqual([]);
    expect(analysis.risks).toEqual([]);
  });

  test("computes per-instance connection usage and remaining agent headroom", () => {
    const analysis = analyzeHostCapacity([
      sample("2026-07-18T10:00:00.000Z", {
        pgConnections: [
          { role: "shared", usedConnections: 55, maxConnections: 100, agentPoolSize: 10 },
        ],
      }),
    ]);

    expect(analysis.postgres.instances).toEqual([
      {
        role: "shared",
        usedConnections: 55,
        maxConnections: 100,
        usedPercent: 55,
        estimatedAdditionalAgents: 4,
      },
    ]);
    expect(analysis.risks).toEqual([]);
    expect(analysis.overall).toBe("healthy");
  });

  test("keeps agent headroom null for a control-only instance", () => {
    const analysis = analyzeHostCapacity([
      sample("2026-07-18T10:00:00.000Z", {
        pgConnections: [
          { role: "control", usedConnections: 20, maxConnections: 100, agentPoolSize: null },
          { role: "workflow", usedConnections: 60, maxConnections: 300, agentPoolSize: 5 },
        ],
      }),
    ]);

    const [control, workflow] = analysis.postgres.instances;
    expect(control?.estimatedAdditionalAgents).toBeNull();
    expect(workflow?.estimatedAdditionalAgents).toBe(48);
  });

  test("warns when an instance nears max_connections and escalates when it is almost full", () => {
    const warning = analyzeHostCapacity([
      sample("2026-07-18T10:00:00.000Z", {
        pgConnections: [
          { role: "workflow", usedConnections: 240, maxConnections: 300, agentPoolSize: 10 },
        ],
      }),
    ]);
    expect(warning.overall).toBe("warning");
    expect(warning.risks).toContainEqual(
      expect.objectContaining({
        code: "postgres_connections",
        severity: "warning",
        message: expect.stringContaining("Workflow Postgres"),
      }),
    );

    const critical = analyzeHostCapacity([
      sample("2026-07-18T10:00:00.000Z", {
        pgConnections: [
          { role: "shared", usedConnections: 95, maxConnections: 100, agentPoolSize: 10 },
        ],
      }),
    ]);
    expect(critical.overall).toBe("critical");
    expect(critical.risks).toContainEqual(
      expect.objectContaining({
        code: "postgres_connections",
        severity: "critical",
        message: expect.stringContaining("53300"),
      }),
    );
  });
});
