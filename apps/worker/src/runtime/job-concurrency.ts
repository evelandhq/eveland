import os from "node:os";

const GIB = 1024 ** 3;

export type MachineSpec = {
  totalMemoryBytes: number;
  cpuCoreCount: number;
};

/**
 * How many builds this host can absorb at once, from the sizing model in
 * docs/en/operations/capacity.md: one build peaks at
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

/**
 * How many claimed jobs the worker's pump runs at once. Sized for the
 * expensive light job — a Deployment activation whose `eve start` bursts ~2
 * cores while the Agent boots — so leave one core for the control plane and
 * cap at 3: queue drain beyond that buys nothing while concurrent cold starts
 * manufacture health-check timeouts on the very sessions the pump exists to
 * rescue. Builds are additionally bounded by the heavy-job cap.
 */
export function deriveWorkerJobConcurrency(machine: MachineSpec): number {
  return Math.max(1, Math.min(machine.cpuCoreCount - 1, 3));
}

export function resolveWorkerJobConcurrency(
  env: NodeJS.ProcessEnv,
  machine: MachineSpec = { totalMemoryBytes: os.totalmem(), cpuCoreCount: os.cpus().length },
): number {
  const parsed = Number.parseInt(env.WORKER_JOB_CONCURRENCY ?? "", 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return deriveWorkerJobConcurrency(machine);
}
