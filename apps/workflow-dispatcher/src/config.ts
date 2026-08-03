import os from "node:os";

export type DispatcherConfiguration = {
  worldUrl: string;
  apiUrl: string;
  poolSize: number;
  concurrency: number;
  pollIntervalMs: number;
  maxInFlightPerTenant: number;
  dispatchTimeoutMs: number;
  leaseRenewIntervalMs: number;
};

/**
 * The activation lease TTL the control API issues. The dispatcher does not set
 * it; it only has to renew inside it, so this mirrors the API's own default
 * (`EVELAND_ACTIVATION_LEASE_TTL_MS`).
 */
const ACTIVATION_LEASE_TTL_MS = 180_000;

/**
 * How many tenants one dispatcher may have in flight at once, derived from the
 * machine the way build concurrency is. A held dispatch costs one socket and
 * one PG connection slot, not a core, so this is far more generous than the
 * build cap — the point is a ceiling, not a throttle.
 */
export function deriveMaxInFlightPerTenant(machine: { cpuCoreCount: number }): number {
  return Math.max(2, Math.min(16, machine.cpuCoreCount));
}

export function resolveDispatcherConfig(env: NodeJS.ProcessEnv): DispatcherConfiguration {
  const worldUrl = env.EVELAND_WORKFLOW_WORLD_URL ?? env.WORKFLOW_POSTGRES_URL;
  if (!worldUrl) {
    throw new Error(
      "EVELAND_WORKFLOW_WORLD_URL is required: the dispatcher claims jobs from the shared workflow database.",
    );
  }

  const leaseRenewIntervalMs = positiveNumber(env.EVELAND_WORKFLOW_LEASE_RENEW_INTERVAL_MS, 60_000);
  if (leaseRenewIntervalMs >= ACTIVATION_LEASE_TTL_MS) {
    throw new Error(
      `EVELAND_WORKFLOW_LEASE_RENEW_INTERVAL_MS (${String(leaseRenewIntervalMs)}ms) must be well below the ` +
        `activation lease TTL (${String(ACTIVATION_LEASE_TTL_MS)}ms), or a long step loses its executor mid-flight.`,
    );
  }

  return {
    worldUrl,
    apiUrl: env.EVELAND_API_INTERNAL_URL ?? "http://127.0.0.1:4000",
    poolSize: positiveNumber(env.EVELAND_WORKFLOW_DISPATCHER_POOL_SIZE, 10),
    concurrency: positiveNumber(env.EVELAND_WORKFLOW_DISPATCHER_CONCURRENCY, 50),
    pollIntervalMs: positiveNumber(env.EVELAND_WORKFLOW_DISPATCHER_POLL_INTERVAL_MS, 500),
    maxInFlightPerTenant: positiveNumber(
      env.EVELAND_WORKFLOW_MAX_INFLIGHT_PER_PROJECT,
      deriveMaxInFlightPerTenant({ cpuCoreCount: os.cpus().length }),
    ),
    // Steps are unbounded in principle (model calls), so the timeout is a
    // backstop against a wedged executor rather than a service-level deadline.
    // Liveness is the lease renewal's job, not this.
    dispatchTimeoutMs: positiveNumber(env.EVELAND_WORKFLOW_DISPATCH_TIMEOUT_MS, 900_000),
    leaseRenewIntervalMs,
  };
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
