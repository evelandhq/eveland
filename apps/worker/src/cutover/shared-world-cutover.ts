import type { Store } from "@evelandhq/db";
import {
  countClaimableUnscopedFlowJobs,
  DISPATCH_VERSION,
  listUnresolvedRunQuarantines,
  migrateUnscopedRunJobs,
  quarantineRun,
} from "@evelandhq/workflow-world";
import { makeWorkerUtils } from "graphile-worker";
import pg from "pg";

/**
 * The maintenance-downtime cutover over the shared workflow World (issue
 * #278). Every step is idempotent under one operation id and the command
 * fails closed: objects it cannot prove stay fenced/quarantined, and the
 * postcondition refuses dispatcher startup while anything claimable remains
 * outside a per-run queue or any non-recoverable run is neither terminal nor
 * durably quarantined.
 *
 * This module orchestrates; the queue-internal algorithms (job migration,
 * quarantine parking) are owned and tested by `@evelandhq/workflow-world`.
 */

export type SharedRunClassification =
  | "recoverable_shared"
  | "queue_migration_required"
  | "managed_termination_required"
  | "quarantined_unknown";

export type SharedRunAssessment = {
  tenantId: string;
  runId: string;
  deploymentId: string | null;
  queueNamespace: string | null;
  classification: SharedRunClassification;
  reasons: string[];
};

export type CutoverStore = Pick<
  Store,
  | "getDeployment"
  | "getRelease"
  | "ensureWorkflowCutoverOperation"
  | "advanceWorkflowCutoverOperation"
  | "getWorkflowCutoverOperation"
  | "writeWorkflowFences"
  | "convergeWorkflowTermination"
  | "updateDeploymentWorkflowTopology"
>;

type ActiveRunRow = {
  tenant_id: string;
  id: string;
  deployment_id: string | null;
  queue_namespace: string | null;
  status: string;
  dead_letter_reason: string | null;
};

const CORRUPTION_PATTERN = /REPLAY_DIVERGENCE|CORRUPTED_EVENT_LOG/i;

/**
 * Classify every active shared run against the recoverability gate. A
 * Release/Deployment classification alone never makes a run recoverable —
 * each run must individually prove non-corruption, exact ownership, known
 * namespace, protocol compatibility and a per-run-queue-capable owner.
 */
export async function assessSharedActiveRuns(
  pool: pg.Pool,
  store: Pick<Store, "getDeployment" | "getRelease">,
  options: { corruptedRuns?: Array<{ tenantId: string; runId: string }> } = {},
): Promise<SharedRunAssessment[]> {
  const { rows } = await pool.query<ActiveRunRow>(
    `select runs.tenant_id, runs.id, runs.deployment_id, runs.queue_namespace, runs.status,
            (select dead.reason
               from workflow.dispatch_dead_letters as dead
              where dead.tenant_id = runs.tenant_id
                and dead.run_id = runs.id
                and dead.resolved_at is null
              order by dead.created_at desc
              limit 1) as dead_letter_reason
       from workflow.workflow_runs as runs
      where runs.status in ('pending', 'running')
      order by runs.tenant_id, runs.id`,
  );
  const explicitlyCorrupted = new Set(
    (options.corruptedRuns ?? []).map((run) => `${run.tenantId}:${run.runId}`),
  );

  const assessments: SharedRunAssessment[] = [];
  for (const row of rows) {
    const reasons: string[] = [];
    let classification: SharedRunClassification = "recoverable_shared";

    const corrupted =
      explicitlyCorrupted.has(`${row.tenant_id}:${row.id}`) ||
      (row.dead_letter_reason !== null && CORRUPTION_PATTERN.test(row.dead_letter_reason));
    if (corrupted) {
      classification = "managed_termination_required";
      reasons.push("event log corruption signal (dead letter or operator input)");
    }

    const deployment = row.deployment_id ? await store.getDeployment(row.deployment_id) : null;
    const release = deployment ? await store.getRelease(deployment.releaseId) : null;
    if (!deployment || !release) {
      if (classification === "recoverable_shared") classification = "quarantined_unknown";
      reasons.push(
        row.deployment_id
          ? `owner deployment ${row.deployment_id} is not retained in the control plane`
          : "run records no owner deployment",
      );
    } else {
      if (release.workflow.worldKind !== "shared") {
        if (classification === "recoverable_shared") classification = "quarantined_unknown";
        reasons.push(
          `owner Release ${release.id} attestation is ${release.workflow.worldKind}, not shared`,
        );
      }
      if (release.workflow.enqueueCapability !== "per_run_queue_v1") {
        // Even fully-migrated jobs do not help: the immutable owner would keep
        // producing unscoped jobs the moment it resumes. v1 has no bridge.
        classification = "managed_termination_required";
        reasons.push(
          `owner Release ${release.id} enqueue capability is ${release.workflow.enqueueCapability}; v1 has no compatibility bridge`,
        );
      }
      if (
        release.workflow.dispatchProtocol === null ||
        release.workflow.dispatchProtocol > DISPATCH_VERSION
      ) {
        classification = "managed_termination_required";
        reasons.push(
          `owner Release ${release.id} dispatch protocol ${String(release.workflow.dispatchProtocol)} is outside the dispatcher window`,
        );
      }
    }

    // Job scoping: unscoped-but-decodable jobs are migratable; the migration
    // helper itself parks anything it cannot prove.
    const unscoped = await pool.query<{ count: string }>(
      `select count(*)::text as count
         from graphile_worker._private_jobs as jobs
         join graphile_worker._private_tasks as tasks on tasks.id = jobs.task_id
         left join graphile_worker._private_job_queues as queues on queues.id = jobs.job_queue_id
        where tasks.identifier = 'eveland_wf_flows'
          and jobs.payload->>'tenantId' = $1
          and (queues.queue_name is null or queues.queue_name not like 'wfrun:%')
          and convert_from(decode(jobs.payload->>'data', 'base64'), 'utf8')::jsonb->>'runId' = $2`,
      [row.tenant_id, row.id],
    );
    const unscopedJobs = Number(unscoped.rows[0]!.count);

    if (classification === "recoverable_shared") {
      if (row.queue_namespace === null && unscopedJobs === 0) {
        // NULL means "never recorded"; with no job payload to prove it either
        // way, recovery would have to guess the executor's topic. It may not.
        classification = "quarantined_unknown";
        reasons.push("queue namespace was never recorded and no job payload can prove it");
      } else if (unscopedJobs > 0) {
        classification = "queue_migration_required";
        reasons.push(`${String(unscopedJobs)} job(s) still outside the per-run queue`);
      }
    }

    assessments.push({
      tenantId: row.tenant_id,
      runId: row.id,
      deploymentId: row.deployment_id,
      queueNamespace: row.queue_namespace,
      classification,
      reasons,
    });
  }
  return assessments;
}

export type CutoverPrepareResult = {
  operationId: string;
  assessments: SharedRunAssessment[];
  migration: { scoped: number; parked: number; backfilledNamespaces: number };
  terminated: Array<{ tenantId: string; runId: string }>;
  quarantined: Array<{ tenantId: string; runId: string }>;
  staged: string[];
  converged: { failedSessions: number; removedSessionBindings: number };
};

/**
 * Steps 6-11 of the maintenance-downtime cutover, idempotent under one
 * operation id: inventory, classify, terminate/quarantine what cannot be
 * recovered, migrate what can, stage the surviving deployments to
 * `converting`, and verify the database postcondition. `finalize` is a
 * separate explicit step after the post-resume continuity gate.
 */
export async function prepareSharedWorldCutover(input: {
  pool: pg.Pool;
  store: CutoverStore;
  operationId: string;
  corruptedRuns?: Array<{ tenantId: string; runId: string }>;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}): Promise<CutoverPrepareResult> {
  const { pool, store, operationId } = input;
  const log = input.log ?? (() => {});
  const workerUtils = await makeWorkerUtils({ pgPool: pool });
  try {
    await store.ensureWorkflowCutoverOperation({
      id: operationId,
      kind: "cutover",
      scope: {},
    });

    const assessments = await assessSharedActiveRuns(pool, store, {
      ...(input.corruptedRuns ? { corruptedRuns: input.corruptedRuns } : {}),
    });

    // Fence first — in the control plane, before any workflow database write.
    const nonRecoverable = assessments.filter(
      (assessment) =>
        assessment.classification === "managed_termination_required" ||
        assessment.classification === "quarantined_unknown",
    );
    const fencedDeployments = [
      ...new Set(
        nonRecoverable.flatMap((assessment) =>
          assessment.deploymentId ? [assessment.deploymentId] : [],
        ),
      ),
    ];
    await store.writeWorkflowFences(operationId, [
      ...fencedDeployments.map((deploymentId) => ({
        scopeKind: "deployment" as const,
        scopeId: deploymentId,
        reason: "workflow managed termination in progress",
      })),
      ...nonRecoverable.map((assessment) => ({
        scopeKind: "run" as const,
        scopeId: `${assessment.tenantId}:${assessment.runId}`,
        reason: assessment.reasons.join("; ") || assessment.classification,
      })),
    ]);
    await store.advanceWorkflowCutoverOperation(operationId, {
      phase: "fenced",
      checkpoint: { key: "assessments", value: summarize(assessments) },
    });

    // Workflow-safe: cancel what the World will let us cancel; durably
    // quarantine the rest so boot recovery, enqueue and the handler all see it.
    const terminated: Array<{ tenantId: string; runId: string }> = [];
    const quarantined: Array<{ tenantId: string; runId: string }> = [];
    for (const assessment of nonRecoverable) {
      const target = { tenantId: assessment.tenantId, runId: assessment.runId };
      const cancelled = await cancelRunDirectly(pool, target);
      if (cancelled) {
        terminated.push(target);
      }
      // Corrupted or not, a quarantine marker keeps any racing or historical
      // job from being claimed, and parks existing payloads intact.
      await quarantineRun(pool, workerUtils, {
        ...target,
        operationId,
        reason: assessment.reasons.join("; ") || assessment.classification,
      });
      quarantined.push(target);
      log("managed termination staged", { ...target, cancelled });
    }

    // In-place migration for provable early-external jobs (owners already
    // attested per_run_queue_v1 — anything else was terminated above).
    const migration = await migrateUnscopedRunJobs(pool, { log });

    await store.advanceWorkflowCutoverOperation(operationId, {
      phase: "workflow_safe",
      checkpoint: {
        key: "workflow_safe",
        value: {
          terminated: terminated.length,
          quarantined: quarantined.length,
          migratedJobs: migration.scoped,
          parkedJobs: migration.parked.length,
        },
      },
    });

    // Control-plane convergence for the terminated owners.
    const converged = await store.convergeWorkflowTermination(operationId, fencedDeployments);
    await store.advanceWorkflowCutoverOperation(operationId, {
      phase: "control_plane_converged",
      checkpoint: { key: "converged", value: converged },
    });

    // Stage surviving shared deployments to `converting`; finalize comes only
    // after the post-resume continuity gate.
    const staged: string[] = [];
    const recoverableDeployments = new Set(
      assessments
        .filter(
          (assessment) =>
            assessment.classification === "recoverable_shared" ||
            assessment.classification === "queue_migration_required",
        )
        .flatMap((assessment) => (assessment.deploymentId ? [assessment.deploymentId] : [])),
    );
    for (const deploymentId of recoverableDeployments) {
      const updated = await store.updateDeploymentWorkflowTopology(deploymentId, {
        runnerMode: "external",
        conversionState: "converting",
        conversionOperationId: operationId,
      });
      if (updated) staged.push(deploymentId);
    }

    return {
      operationId,
      assessments,
      migration: {
        scoped: migration.scoped,
        parked: migration.parked.length,
        backfilledNamespaces: migration.backfilledNamespaces,
      },
      terminated,
      quarantined,
      staged,
      converged: {
        failedSessions: converged.failedSessions,
        removedSessionBindings: converged.removedSessionBindings,
      },
    };
  } finally {
    await Promise.resolve(workerUtils.release()).catch(() => {});
  }
}

export type CutoverPostcondition = {
  passed: boolean;
  claimableUnscopedJobs: number;
  blockingRuns: Array<{ tenantId: string; runId: string; reason: string }>;
};

/**
 * The database postcondition the dispatcher's `recover-paused` startup and the
 * explicit resume both require: nothing claimable outside a per-run queue, and
 * every non-recoverable active run either workflow-terminal or carrying an
 * unresolved durable quarantine marker. A control-plane fence alone never
 * satisfies this.
 */
export async function verifySharedWorldPostcondition(
  pool: pg.Pool,
  store: Pick<Store, "getDeployment" | "getRelease">,
): Promise<CutoverPostcondition> {
  const claimableUnscopedJobs = await countClaimableUnscopedFlowJobs(pool);
  const quarantines = await listUnresolvedRunQuarantines(pool);
  const quarantinedRuns = new Set(quarantines.map((entry) => `${entry.tenantId}:${entry.runId}`));
  const assessments = await assessSharedActiveRuns(pool, store);
  const blockingRuns = assessments
    .filter(
      (assessment) =>
        (assessment.classification === "managed_termination_required" ||
          assessment.classification === "quarantined_unknown") &&
        !quarantinedRuns.has(`${assessment.tenantId}:${assessment.runId}`),
    )
    .map((assessment) => ({
      tenantId: assessment.tenantId,
      runId: assessment.runId,
      reason: assessment.reasons.join("; ") || assessment.classification,
    }));
  return {
    passed: claimableUnscopedJobs === 0 && blockingRuns.length === 0,
    claimableUnscopedJobs,
    blockingRuns,
  };
}

/**
 * Step 15's tail: after the cross-Release continuity gate has passed on the
 * resumed dispatcher, finalize the staged deployments to `external`.
 */
export async function finalizeSharedWorldCutover(input: {
  store: CutoverStore;
  operationId: string;
  deploymentIds: string[];
}): Promise<string[]> {
  const finalized: string[] = [];
  for (const deploymentId of input.deploymentIds) {
    const updated = await input.store.updateDeploymentWorkflowTopology(deploymentId, {
      conversionState: "external",
      conversionOperationId: input.operationId,
      convertedAt: new Date().toISOString(),
    });
    if (updated) finalized.push(deploymentId);
  }
  await input.store.advanceWorkflowCutoverOperation(input.operationId, {
    phase: "completed",
    checkpoint: { key: "finalized", value: finalized },
  });
  return finalized;
}

/**
 * The World's own cancel semantics via direct terminal update. `run_cancelled`
 * is idempotent upstream; a run the storage layer refuses to modify stays
 * active and is covered by its durable quarantine marker instead.
 */
async function cancelRunDirectly(
  pool: pg.Pool,
  target: { tenantId: string; runId: string },
): Promise<boolean> {
  try {
    const result = await pool.query(
      `update workflow.workflow_runs
          set status = 'cancelled', completed_at = now(), updated_at = now()
        where tenant_id = $1 and id = $2 and status in ('pending', 'running')`,
      [target.tenantId, target.runId],
    );
    return (result.rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

function summarize(assessments: SharedRunAssessment[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const assessment of assessments) {
    summary[assessment.classification] = (summary[assessment.classification] ?? 0) + 1;
  }
  return summary;
}
