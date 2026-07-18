import { readFile, statfs } from "node:fs/promises";
import os from "node:os";
import type { HostMetricSample } from "@eveland/core/instance-health";

export type CpuTimes = { idle: number; total: number };

type FileSystemStats = {
  blocks: number | bigint;
  bsize: number | bigint;
  bavail: number | bigint;
  files: number | bigint;
  ffree: number | bigint;
};

type HostMetricDependencies = {
  now: () => Date;
  cpuTimes: () => CpuTimes;
  loadAverage: () => number[];
  totalMemory: () => number;
  availableMemory: () => number | Promise<number>;
  statfs: (path: string) => Promise<FileSystemStats>;
};

const defaultDependencies: HostMetricDependencies = {
  now: () => new Date(),
  cpuTimes: readCpuTimes,
  loadAverage: () => os.loadavg(),
  totalMemory: () => os.totalmem(),
  availableMemory: readAvailableMemory,
  statfs: (path) => statfs(path),
};

export function cpuPercentBetween(previous: CpuTimes | null, current: CpuTimes): number | null {
  if (!previous) return null;
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0) return null;
  const percent = (1 - idleDelta / totalDelta) * 100;
  return Math.round(Math.max(0, Math.min(100, percent)) * 10) / 10;
}

export function parseMemAvailable(contents: string): number | null {
  const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(contents);
  return match?.[1] ? Number(match[1]) * 1024 : null;
}

export async function collectHostMetric(
  workerId: string,
  dataDir: string,
  previousCpuTimes: CpuTimes | null,
  dependencies: HostMetricDependencies = defaultDependencies,
): Promise<{ sample: Omit<HostMetricSample, "id">; cpuTimes: CpuTimes }> {
  const [filesystem, memoryAvailableBytes] = await Promise.all([
    dependencies.statfs(dataDir),
    dependencies.availableMemory(),
  ]);
  const currentCpuTimes = dependencies.cpuTimes();
  const blockSize = Number(filesystem.bsize);
  const load1 = dependencies.loadAverage()[0] ?? 0;
  return {
    sample: {
      workerId,
      observedAt: dependencies.now().toISOString(),
      cpuPercent: cpuPercentBetween(previousCpuTimes, currentCpuTimes),
      load1,
      memoryTotalBytes: dependencies.totalMemory(),
      memoryAvailableBytes,
      diskTotalBytes: Number(filesystem.blocks) * blockSize,
      diskAvailableBytes: Number(filesystem.bavail) * blockSize,
      diskInodesTotal: Number(filesystem.files),
      diskInodesAvailable: Number(filesystem.ffree),
    },
    cpuTimes: currentCpuTimes,
  };
}

function readCpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

async function readAvailableMemory(): Promise<number> {
  try {
    return parseMemAvailable(await readFile("/proc/meminfo", "utf8")) ?? os.freemem();
  } catch {
    return os.freemem();
  }
}
