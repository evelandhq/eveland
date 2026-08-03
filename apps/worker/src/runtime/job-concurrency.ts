import os from "node:os";

const GIB = 1024 ** 3;

export type MachineSpec = {
  totalMemoryBytes: number;
  cpuCoreCount: number;
};

/**
 * How many builds this host can absorb at once, from the sizing model in
 * docs/deploy/linux.md "Capacity planning (single host)": one build peaks at
 * 1-2 GB and bursts ~2 cores, so budget one build per 4 GiB of RAM while
 * leaving two cores for the control plane and running Agents. Never below one,
 * or deploys would deadlock on small hosts.
 */
export function deriveMaxConcurrentHeavyJobs(machine: MachineSpec): number {
  return Math.max(
    1,
    Math.min(Math.floor(machine.totalMemoryBytes / (4 * GIB)), machine.cpuCoreCount - 2),
  );
}

export function resolveMaxConcurrentHeavyJobs(
  env: NodeJS.ProcessEnv,
  machine: MachineSpec = { totalMemoryBytes: os.totalmem(), cpuCoreCount: os.cpus().length },
): number {
  const parsed = Number.parseInt(env.EVELAND_MAX_CONCURRENT_JOBS ?? "", 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return deriveMaxConcurrentHeavyJobs(machine);
}
