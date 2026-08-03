import { MessageData } from "@eveland/workflow-world";
import type { Pool } from "pg";
import type { ActivationClient } from "./activation-client.js";
import { withRenewedLease } from "./lease.js";
import { postVqsMessage, type VqsResult } from "./vqs-client.js";

/**
 * Where a message should execute, and whether it can execute at all.
 *
 * The run row is authoritative: an in-flight run is pinned to the deployment
 * that created it, because that is the only build whose bundle can replay its
 * event log. The message's own `deploymentId` is a hint used when no run row
 * exists yet (the very first delivery of a run).
 */
export type Affinity =
  | { type: "deployment"; deploymentId: string; runId?: string }
  | { type: "unroutable"; reason: string };

export type RunLookup = (input: {
  tenantId: string;
  runId: string;
}) => Promise<{ deploymentId: string; status: string } | null>;

export type DispatchOutcome =
  | { type: "completed" }
  | { type: "rescheduled"; timeoutSeconds: number }
  | { type: "dead-letter"; reason: string }
  | { type: "retry"; reason: string };

export type DispatcherDeps = {
  activation: ActivationClient;
  runLookup: RunLookup;
  runtimeSecret: string;
  credential: string;
  dispatchTimeoutMs: number;
  leaseRenewIntervalMs: number;
  reenqueue: (input: {
    jobName: string;
    message: MessageData;
    delaySeconds: number;
  }) => Promise<void>;
  onDeadLetter: (input: { message: MessageData; reason: string }) => Promise<void>;
  log?: (message: string, meta?: Record<string, unknown>) => void;
};

/** Extracts the run id from a vqs payload without interpreting the rest of it. */
export function readRunId(message: MessageData): string | undefined {
  try {
    const body = JSON.parse(Buffer.from(message.data).toString("utf8")) as {
      runId?: unknown;
      workflowRunId?: unknown;
    };
    if (typeof body.runId === "string") return body.runId;
    // Step invocations name it differently.
    if (typeof body.workflowRunId === "string") return body.workflowRunId;
  } catch {
    // A body the dispatcher cannot read is still dispatchable — affinity just
    // falls back to the message's deployment hint.
  }
  return undefined;
}

export async function resolveAffinity(
  message: MessageData,
  runLookup: RunLookup,
): Promise<Affinity> {
  const runId = readRunId(message);
  if (!runId) {
    return { type: "deployment", deploymentId: message.deploymentId };
  }
  const run = await runLookup({ tenantId: message.tenantId, runId });
  if (!run) {
    // First delivery: the run row is created by the executor when it handles
    // this very message, so the enqueuing deployment is the right target.
    return { type: "deployment", deploymentId: message.deploymentId, runId };
  }
  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
    return {
      type: "unroutable",
      reason: `Run ${runId} is already terminal (${run.status}).`,
    };
  }
  return { type: "deployment", deploymentId: run.deploymentId, runId };
}

/**
 * One message, start to finish. Every branch maps onto a row of the design's
 * failure table, and the caller turns the outcome into graphile's vocabulary
 * (return = done, throw = retry).
 */
export async function dispatchMessage(
  input: {
    message: MessageData;
    jobName: string;
    queueName: string;
    route: "flow" | "step";
    attempt: number;
  },
  deps: DispatcherDeps,
): Promise<DispatchOutcome> {
  const { message } = input;
  const affinity = await resolveAffinity(message, deps.runLookup);
  if (affinity.type === "unroutable") {
    // Not an error: a terminal run's straggler message has nowhere to go and
    // nothing to do. Dropping it is correct and must not burn retries.
    deps.log?.("dropping message for terminal run", {
      tenantId: message.tenantId,
      reason: affinity.reason,
    });
    return { type: "completed" };
  }

  const activation = await deps.activation.activate({
    deploymentId: affinity.deploymentId,
    kind: "workflow",
    ownerId: `workflow-dispatcher:${message.messageId}`,
  });

  if (activation.type === "not-activatable") {
    // Archived or failed deployment: no retry can produce an executor. This is
    // the case the retention guard exists to prevent, so it is worth an alarm
    // rather than a silent drop.
    return {
      type: "dead-letter",
      reason: `Deployment ${affinity.deploymentId} is not activatable: ${activation.message}`,
    };
  }
  if (activation.type === "unavailable") {
    return {
      type: "retry",
      reason: `Activation failed (HTTP ${String(activation.status)}): ${activation.message}`,
    };
  }

  const result: VqsResult = await withRenewedLease(
    {
      client: deps.activation,
      leaseId: activation.activation.leaseId,
      renewIntervalMs: deps.leaseRenewIntervalMs,
      onRenewFailure: (leaseId) =>
        deps.log?.("activation lease renewal failed", { leaseId, tenantId: message.tenantId }),
    },
    (signal) =>
      postVqsMessage({
        endpointPort: activation.activation.endpointPort,
        route: input.route,
        queueName: input.queueName,
        messageId: message.messageId,
        attempt: input.attempt,
        body: message.data,
        ...(message.headers ? { headers: message.headers } : {}),
        tenantId: message.tenantId,
        deploymentId: affinity.deploymentId,
        ...(affinity.runId ? { runId: affinity.runId } : {}),
        runtimeSecret: deps.runtimeSecret,
        credential: deps.credential,
        timeoutMs: deps.dispatchTimeoutMs,
        signal,
      }),
  );

  if (result.type === "completed") return { type: "completed" };

  if (result.type === "reschedule") {
    // Enqueued before returning, so a dispatcher crash between the two cannot
    // lose the wake-up. The message id is preserved deliberately: the runtime
    // uses it as the step-ownership lease.
    await deps.reenqueue({
      jobName: input.jobName,
      message: { ...message, attempt: input.attempt + 1 },
      delaySeconds: result.timeoutSeconds,
    });
    return { type: "rescheduled", timeoutSeconds: result.timeoutSeconds };
  }

  if (!result.retryable) {
    return {
      type: "dead-letter",
      reason: `Executor rejected the dispatch with HTTP ${String(result.status)}: ${result.text}`,
    };
  }
  return {
    type: "retry",
    reason: `Dispatch failed (HTTP ${String(result.status)}): ${result.text}`,
  };
}

/**
 * Per-tenant in-flight accounting behind graphile's `forbiddenFlags`.
 *
 * graphile can only express a deny-list, which is the right shape here: a
 * tenant at its cap is skipped for this claim so the runner moves on to another
 * tenant's jobs, instead of one busy project monopolising the pool.
 */
export function createFairness(input: { maxInFlightPerTenant: number }) {
  const inFlight = new Map<string, number>();
  return {
    forbiddenFlags(): string[] {
      const forbidden: string[] = [];
      for (const [tenantId, count] of inFlight) {
        if (count >= input.maxInFlightPerTenant) forbidden.push(`project:${tenantId}`);
      }
      return forbidden;
    },
    acquire(tenantId: string): void {
      inFlight.set(tenantId, (inFlight.get(tenantId) ?? 0) + 1);
    },
    release(tenantId: string): void {
      const next = (inFlight.get(tenantId) ?? 1) - 1;
      if (next <= 0) inFlight.delete(tenantId);
      else inFlight.set(tenantId, next);
    },
    snapshot(): Record<string, number> {
      return Object.fromEntries(inFlight);
    },
  };
}

export type Fairness = ReturnType<typeof createFairness>;

/** Reads a run's deployment and status straight from the shared world schema. */
export function createRunLookup(pool: Pool): RunLookup {
  return async ({ tenantId, runId }) => {
    const { rows } = await pool.query<{ deployment_id: string; status: string }>(
      `select deployment_id, status
         from workflow.workflow_runs
        where tenant_id = $1 and id = $2
        limit 1`,
      [tenantId, runId],
    );
    const row = rows[0];
    return row ? { deploymentId: row.deployment_id, status: row.status } : null;
  };
}
