import { describe, expect, test } from "vitest";
import {
  collectHostMetric,
  cpuPercentBetween,
  parseMemAvailable,
  type CpuTimes,
} from "./host-metrics.js";

describe("host metric collection", () => {
  test("uses Linux MemAvailable instead of cache-sensitive free memory", () => {
    expect(parseMemAvailable("MemTotal:       16384000 kB\nMemFree:          500000 kB\nMemAvailable:    6400000 kB\n")).toBe(6_553_600_000);
    expect(parseMemAvailable("MemTotal: 1000 kB\n")).toBeNull();
  });

  test("derives CPU utilization from consecutive cumulative counters", () => {
    const previous: CpuTimes = { idle: 1_000, total: 2_000 };
    const current: CpuTimes = { idle: 1_250, total: 2_500 };

    expect(cpuPercentBetween(previous, current)).toBe(50);
    expect(cpuPercentBetween(current, current)).toBeNull();
  });

  test("collects memory, load, filesystem capacity, and inode headroom", async () => {
    const result = await collectHostMetric("worker-1", "/var/lib/eveland", { idle: 100, total: 200 }, {
      now: () => new Date("2026-07-18T10:00:00.000Z"),
      cpuTimes: () => ({ idle: 150, total: 300 }),
      loadAverage: () => [1.25, 0.8, 0.5],
      totalMemory: () => 16_000,
      availableMemory: () => 6_000,
      statfs: async (path) => {
        expect(path).toBe("/var/lib/eveland");
        return {
          blocks: 1_000,
          bsize: 4_096,
          bavail: 250,
          files: 10_000,
          ffree: 8_000,
        };
      },
    });

    expect(result.sample).toEqual({
      workerId: "worker-1",
      observedAt: "2026-07-18T10:00:00.000Z",
      cpuPercent: 50,
      load1: 1.25,
      memoryTotalBytes: 16_000,
      memoryAvailableBytes: 6_000,
      diskTotalBytes: 4_096_000,
      diskAvailableBytes: 1_024_000,
      diskInodesTotal: 10_000,
      diskInodesAvailable: 8_000,
    });
    expect(result.cpuTimes).toEqual({ idle: 150, total: 300 });
  });
});
