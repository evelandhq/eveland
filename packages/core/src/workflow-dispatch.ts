import type { WorkflowDispatcherRegistration } from "./contracts.js";

/**
 * Stable managed error codes for workflow-topology refusals. API and Gateway
 * map these onto user-facing errors; the codes are the contract, the free text
 * after them is diagnostics.
 */
export const WORKFLOW_UNAVAILABLE = "workflow_unavailable";
export const WORKFLOW_MIGRATION_REQUIRED = "workflow_migration_required";

export const WORKFLOW_DISPATCHER_HEARTBEAT_TTL_MS = 60_000;

/** One id from Web through API, Gateway, activation and dispatcher logs. */
export const CANONICAL_REQUEST_ID_HEADER = "x-eveland-request-id";

/**
 * The canonical end-to-end request budget. The Web proxy must cover the whole
 * chain — cold activation plus the upstream idle timeout plus a transport
 * margin — or the browser sees Next's blank 500 while the API/Gateway are
 * still mid-flight and their real result is thrown away.
 */
export function resolveCanonicalRequestBudget(env: NodeJS.ProcessEnv): {
  coldStartMs: number;
  upstreamMs: number;
  marginMs: number;
  totalMs: number;
} {
  const coldStartMs = positiveOr(env.EVELAND_COLD_START_TIMEOUT_MS, 30_000);
  const upstreamMs = Math.max(
    positiveOr(env.EVELAND_PLAYGROUND_TIMEOUT_MS, 120_000),
    positiveOr(env.EVELAND_GATEWAY_UPSTREAM_TIMEOUT_MS, 120_000),
  );
  const marginMs = positiveOr(env.EVELAND_WEB_PROXY_MARGIN_MS, 15_000);
  return { coldStartMs, upstreamMs, marginMs, totalMs: coldStartMs + upstreamMs + marginMs };
}

function positiveOr(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveDispatcherHeartbeatTtlMs(env: NodeJS.ProcessEnv): number {
  const parsed = Number.parseInt(env.EVELAND_WORKFLOW_DISPATCHER_HEARTBEAT_TTL_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : WORKFLOW_DISPATCHER_HEARTBEAT_TTL_MS;
}

/**
 * Freshness check the activation path, the production deploy gate and the
 * cutover share. A missing, stale, ownerless or failed registration means the
 * external dispatcher cannot be proven to be claiming — everything that
 * depends on it fails closed with a managed reason instead of timing out.
 * systemd "active" and the stdout token never substitute for this.
 */
export function assessDispatcherReadiness(
  registration: WorkflowDispatcherRegistration | null,
  input: { now?: Date; ttlMs?: number; allowPaused?: boolean } = {},
): { ready: true } | { ready: false; reason: string } {
  const ttlMs = input.ttlMs ?? WORKFLOW_DISPATCHER_HEARTBEAT_TTL_MS;
  const now = input.now ?? new Date();
  if (!registration) {
    return {
      ready: false,
      reason: `${WORKFLOW_UNAVAILABLE}: no workflow dispatcher registration exists`,
    };
  }
  const age = now.getTime() - new Date(registration.lastHeartbeatAt).getTime();
  if (age > ttlMs) {
    return {
      ready: false,
      reason: `${WORKFLOW_UNAVAILABLE}: dispatcher heartbeat is ${String(age)}ms old (ttl ${String(ttlMs)}ms)`,
    };
  }
  if (!registration.ownershipAcquired || !registration.bootRecoveryCompleted) {
    return {
      ready: false,
      reason: `${WORKFLOW_UNAVAILABLE}: dispatcher has not completed ownership and boot recovery`,
    };
  }
  const acceptable = input.allowPaused ? ["ready", "ready_paused"] : ["ready"];
  if (!acceptable.includes(registration.state)) {
    return {
      ready: false,
      reason: `${WORKFLOW_UNAVAILABLE}: dispatcher is ${registration.state}`,
    };
  }
  return { ready: true };
}
