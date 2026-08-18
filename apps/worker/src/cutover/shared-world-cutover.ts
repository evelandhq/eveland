import type { Store } from "@evelandhq/db";
import {
  countClaimableUnscopedFlowJobs,
  DISPATCH_VERSION,
  listUnresolvedRunQuarantines,
  migrateUnscopedRunJobs,
  quarantineRun,
  readFlowJobRun,
  runQueueName,
} from "@evelandhq/workflow-world";
import { makeWorkerUtils } from "graphile-worker";
import pg from "pg";
import { classifyArtifactFromFilesystem, type ArtifactClassifier } from "./artifact-classifier.js";

/**
 * The maintenance-downtime cutover over the shared workflow World (issue
 * #278). Every step is idempotent under one operation id and the command
 * fails closed: objects it cannot prove stay fenced/quarantined, and the
 * postcondition refuses dispatcher startup while anything claimable remains
 * outside its run's exact per-run queue or any non-recoverable run is neither
 * terminal nor durably quarantined.
 *
 * Fence scoping is deliberate: a DEPLOYMENT fence — which blocks every
 * activation path and drives control-plane convergence — is reserved for
 * owners that are permanently retired (non-shared attestation, or an
 * immutable Release that cannot enqueue per-run). A shared-capable owner with
 * one bad run keeps serving its healthy runs; only the bad run is fenced and
 * durably quarantined.
 *
 * This module orchestrates; the queue-internal algorithms (job migration,
 * quarantine parking, exact-queue accounting) are owned and tested by
 * `@evelandhq/workflow-world`.
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
  /**
   * True when the OWNER is disqualified outright — non-shared attestation or
   * an enqueue path that cannot scope future jobs. Only these owners are
   * retired at deployment scope; per-run problems never take a whole
   * Deployment down with them.
   */
  ownerRetired: boolean;
  reasons: string[];
};

export type CutoverStore = Pick<
  Store,
  | "getDeployment"
  | "getRelease"
  | "attestReleaseWorkflow"
  | "listProjects"
  | "listDeployments"
  | "ensureWorkflowCutoverOperation"
  | "advanceWorkflowCutoverOperation"
  | "getWorkflowCutoverOperation"
  | "writeWorkflowFences"
  | "convergeWorkflowTermination"
  | "convergeWorkflowRunFamilies"
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
 *
 * Owners still `unknown` are first classified from their immutable artifact
 * (systemd release directories; Docker images stay unknown for explicit
 * operator disposition) — that persisted attestation, never a guess, is what
 * lets a genuine historical shared run reach `recoverable_shared`.
 */
export async function assessSharedActiveRuns(
  pool: pg.Pool,
  store: Pick<Store, "getDeployment" | "getRelease" | "attestReleaseWorkflow">,
  options: {
    corruptedRuns?: Array<{ tenantId: string; runId: string }>;
    classifier?: ArtifactClassifier;
  } = {},
): Promise<SharedRunAssessment[]> {
  const classifier = options.classifier ?? classifyArtifactFromFilesystem;
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
  // One pass over every claimable flow job: the per-run scoping check compares
  // each job's decoded payload against its run's EXACT queue — a `wfrun:`
  // prefix on some other run's queue proves nothing.
  const { rows: jobRows } = await pool.query<{
    id: string;
    payload: unknown;
    queue_name: string | null;
  }>(
    `select jobs.id::text as id, jobs.payload, queues.queue_name
       from graphile_worker._private_jobs as jobs
       join graphile_worker._private_tasks as tasks on tasks.id = jobs.task_id
       left join graphile_worker._private_job_queues as queues on queues.id = jobs.job_queue_id
      where tasks.identifier = 'eveland_wf_flows'
        and jobs.locked_by is null
        and jobs.attempts < jobs.max_attempts
        and jobs.run_at <= now()`,
  );
  const misScopedJobsByRun = new Map<string, number>();
  for (const jobRow of jobRows) {
    const run = readFlowJobRun(jobRow.payload);
    if (!run) continue; // undecodable: the migration parks it; not attributable here
    if (jobRow.queue_name === runQueueName(run.tenantId, run.runId)) continue;
    const key = `${run.tenantId}:${run.runId}`;
    misScopedJobsByRun.set(key, (misScopedJobsByRun.get(key) ?? 0) + 1);
  }

  const assessments: SharedRunAssessment[] = [];
  for (const row of rows) {
    const reasons: string[] = [];
    let classification: SharedRunClassification = "recoverable_shared";
    let ownerRetired = false;

    const corrupted =
      explicitlyCorrupted.has(`${row.tenant_id}:${row.id}`) ||
      (row.dead_letter_reason !== null && CORRUPTION_PATTERN.test(row.dead_letter_reason));
    if (corrupted) {
      classification = "managed_termination_required";
      reasons.push("event log corruption signal (dead letter or operator input)");
    }

    const deployment = row.deployment_id ? await store.getDeployment(row.deployment_id) : null;
    let release = deployment ? await store.getRelease(deployment.releaseId) : null;
    if (deployment && release && release.workflow.worldKind === "unknown") {
      // Historical artifact classification: persist what the immutable
      // artifact proves, then decide from the persisted record.
      const attestation = await classifier({
        releaseRef: release.imageTag,
        runtimeKind: deployment.runtimeKind,
      });
      if (attestation) {
        release = (await store.attestReleaseWorkflow(release.id, attestation)) ?? release;
      }
    }
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
        // Legacy AND unclassifiable-unknown owners are both retired at
        // deployment scope: run fences are invisible to activation and to the
        // OTLP projector, so an unknown owner left unfenced could keep
        // serving and re-materializing read models.
        ownerRetired = true;
        reasons.push(
          `owner Release ${release.id} attestation is ${release.workflow.worldKind}, not shared`,
        );
      }
      if (
        release.workflow.worldKind === "shared" &&
        release.workflow.enqueueCapability !== "per_run_queue_v1"
      ) {
        // Even fully-migrated jobs do not help: the immutable owner would keep
        // producing unscoped jobs the moment it resumes. v1 has no bridge.
        classification = "managed_termination_required";
        ownerRetired = true;
        reasons.push(
          `owner Release ${release.id} enqueue capability is ${release.workflow.enqueueCapability}; v1 has no compatibility bridge`,
        );
      }
      if (
        release.workflow.worldKind === "shared" &&
        (release.workflow.dispatchProtocol === null ||
          release.workflow.dispatchProtocol > DISPATCH_VERSION)
      ) {
        classification = "managed_termination_required";
        ownerRetired = true;
        reasons.push(
          `owner Release ${release.id} dispatch protocol ${String(release.workflow.dispatchProtocol)} is outside the dispatcher window`,
        );
      }
    }

    const misScopedJobs = misScopedJobsByRun.get(`${row.tenant_id}:${row.id}`) ?? 0;
    if (classification === "recoverable_shared") {
      if (row.queue_namespace === null && misScopedJobs === 0) {
        // NULL means "never recorded"; with no job payload to prove it either
        // way, recovery would have to guess the executor's topic. It may not.
        classification = "quarantined_unknown";
        reasons.push("queue namespace was never recorded and no job payload can prove it");
      } else if (misScopedJobs > 0) {
        classification = "queue_migration_required";
        reasons.push(`${String(misScopedJobs)} job(s) outside the run's exact per-run queue`);
      }
    }

    assessments.push({
      tenantId: row.tenant_id,
      runId: row.id,
      deploymentId: row.deployment_id,
      queueNamespace: row.queue_namespace,
      classification,
      ownerRetired,
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
  /** Deployments permanently retired (fenced + control-plane converged). */
  retiredDeployments: string[];
  /** Unknown-topology deployments fenced pending operator disposition. */
  fencedUnknownDeployments: string[];
  staged: string[];
  converged: { failedSessions: number; removedSessionBindings: number };
  /** Terminated runs whose Eve family could not be proven; operator must map them. */
  unmappedTerminatedRuns: Array<{ tenantId: string; runId: string }>;
};

/**
 * Steps 6-11 of the maintenance-downtime cutover, idempotent under one
 * operation id: classify, terminate/quarantine what cannot be recovered,
 * migrate what can, stage the surviving deployments to `converting`, and
 * verify the database postcondition. `finalize` is a separate explicit step
 * after the post-resume continuity gate.
 */
export async function prepareSharedWorldCutover(input: {
  pool: pg.Pool;
  store: CutoverStore;
  operationId: string;
  corruptedRuns?: Array<{ tenantId: string; runId: string }>;
  /**
   * Operator-provided run→Eve-family mapping for individually terminated
   * runs. The workflow database records no session linkage, so per-run
   * observability convergence can only follow proof; unmapped terminated runs
   * are named in the result for explicit disposition.
   */
  runSessionFamilies?: Array<{ tenantId: string; runId: string; eveSessionId: string }>;
  classifier?: ArtifactClassifier;
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
      ...(input.classifier ? { classifier: input.classifier } : {}),
    });

    // Full control-plane inventory — the shared database's active runs are
    // NOT the whole estate. Legacy Deployments (whose runs live in per-project
    // databases this command never opens) and Deployments with no active
    // shared run must still be classified, fenced, and — for legacy —
    // terminated, or their late telemetry and activations slip every gate.
    const classifier = input.classifier ?? classifyArtifactFromFilesystem;
    const inventoryRetired: string[] = [];
    const inventoryUnknown: string[] = [];
    const inventoryStageable: string[] = [];
    for (const project of await store.listProjects()) {
      for (const deployment of await store.listDeployments(project.id)) {
        if (deployment.status === "archived") continue;
        let release = await store.getRelease(deployment.releaseId);
        if (!release) continue;
        if (release.workflow.worldKind === "unknown") {
          const attestation = await classifier({
            releaseRef: release.imageTag,
            runtimeKind: deployment.runtimeKind,
          });
          if (attestation) {
            release = (await store.attestReleaseWorkflow(release.id, attestation)) ?? release;
          }
        }
        const { worldKind, enqueueCapability } = release.workflow;
        if (
          worldKind === "legacy_project" ||
          (worldKind === "shared" && enqueueCapability !== "per_run_queue_v1")
        ) {
          inventoryRetired.push(deployment.id);
        } else if (worldKind === "unknown") {
          inventoryUnknown.push(deployment.id);
        } else if (
          worldKind === "shared" &&
          deployment.workflowTopology.conversionState === "unclassified"
        ) {
          inventoryStageable.push(deployment.id);
        }
      }
    }

    // Fence first — in the control plane, before any workflow database write.
    // Deployment scope only for permanently retired owners; every other
    // non-recoverable object is fenced at run scope so a healthy sibling run
    // on the same Deployment keeps working.
    const nonRecoverable = assessments.filter(
      (assessment) =>
        assessment.classification === "managed_termination_required" ||
        assessment.classification === "quarantined_unknown",
    );
    const retiredFromRuns = assessments.flatMap((assessment) =>
      assessment.ownerRetired && assessment.deploymentId ? [assessment.deploymentId] : [],
    );
    const fencedUnknownDeployments = [...new Set(inventoryUnknown)];
    const retiredDeployments = [...new Set([...retiredFromRuns, ...inventoryRetired])].filter(
      (deploymentId) => !fencedUnknownDeployments.includes(deploymentId),
    );
    await store.writeWorkflowFences(operationId, [
      ...retiredDeployments.map((deploymentId) => ({
        scopeKind: "deployment" as const,
        scopeId: deploymentId,
        reason: "owner Release permanently retired by the external-only cutover",
      })),
      // Unknown topology stays Deployment-fenced — invisible-to-projector run
      // fences are not enough — but is NOT converged: the operator may still
      // classify it, and convergence is the point of no return.
      ...fencedUnknownDeployments.map((deploymentId) => ({
        scopeKind: "deployment" as const,
        scopeId: deploymentId,
        reason: "unknown workflow topology pending operator disposition",
      })),
      ...nonRecoverable.map((assessment) => ({
        scopeKind: "run" as const,
        scopeId: `${assessment.tenantId}:${assessment.runId}`,
        reason: assessment.reasons.join("; ") || assessment.classification,
      })),
    ]);
    for (const deploymentId of fencedUnknownDeployments) {
      await store.updateDeploymentWorkflowTopology(deploymentId, {
        conversionState: "fenced",
        conversionOperationId: operationId,
      });
    }
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

    // Control-plane convergence — deployment-wide for the permanently retired
    // owners, and per-family for individually terminated runs whose Eve
    // family the operator proved. Unproven families are named, not guessed.
    const converged = await store.convergeWorkflowTermination(operationId, retiredDeployments);
    const retired = new Set(retiredDeployments);
    const familyByRun = new Map(
      (input.runSessionFamilies ?? []).map((entry) => [`${entry.tenantId}:${entry.runId}`, entry]),
    );
    const mappedFamilies: Array<{ projectId: string; eveSessionId: string }> = [];
    const unmappedTerminatedRuns: Array<{ tenantId: string; runId: string }> = [];
    for (const assessment of nonRecoverable) {
      if (assessment.deploymentId && retired.has(assessment.deploymentId)) continue;
      const mapping = familyByRun.get(`${assessment.tenantId}:${assessment.runId}`);
      if (mapping) {
        mappedFamilies.push({
          projectId: mapping.tenantId,
          eveSessionId: mapping.eveSessionId,
        });
      } else {
        unmappedTerminatedRuns.push({
          tenantId: assessment.tenantId,
          runId: assessment.runId,
        });
      }
    }
    const familyConvergence = await store.convergeWorkflowRunFamilies(operationId, mappedFamilies);
    if (unmappedTerminatedRuns.length > 0) {
      log("terminated runs without a proven Eve family; operator mapping required", {
        runs: unmappedTerminatedRuns.length,
      });
    }
    await store.advanceWorkflowCutoverOperation(operationId, {
      phase: "control_plane_converged",
      checkpoint: {
        key: "converged",
        value: {
          ...converged,
          runFamilies: familyConvergence,
          unmappedTerminatedRuns,
        },
      },
    });

    // Stage surviving shared deployments to `converting` — including shared
    // owners with no active run at all. Finalize comes only after the
    // post-resume continuity gate; a retired or unknown deployment never
    // stages, even when it also owns a recoverable-looking run.
    const staged: string[] = [];
    const unstageable = new Set([...retiredDeployments, ...fencedUnknownDeployments]);
    const recoverableDeployments = new Set([
      ...assessments
        .filter(
          (assessment) =>
            assessment.classification === "recoverable_shared" ||
            assessment.classification === "queue_migration_required",
        )
        .flatMap((assessment) => (assessment.deploymentId ? [assessment.deploymentId] : [])),
      ...inventoryStageable,
    ]);
    for (const deploymentId of recoverableDeployments) {
      if (unstageable.has(deploymentId)) continue;
      const updated = await store.updateDeploymentWorkflowTopology(deploymentId, {
        runnerMode: "external",
        conversionState: "converting",
        conversionOperationId: operationId,
      });
      if (updated) staged.push(deploymentId);
    }
    // The staged set is the operation's durable memory: finalize completes
    // only once every one of these has actually finalized.
    await store.advanceWorkflowCutoverOperation(operationId, {
      checkpoint: { key: "staged", value: staged },
    });

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
      retiredDeployments,
      fencedUnknownDeployments,
      staged,
      converged: {
        failedSessions: converged.failedSessions,
        removedSessionBindings: converged.removedSessionBindings,
      },
      unmappedTerminatedRuns,
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
 * explicit resume both require: nothing claimable outside its run's exact
 * per-run queue, and every non-recoverable active run either
 * workflow-terminal or carrying an unresolved durable quarantine marker. A
 * control-plane fence alone never satisfies this.
 */
export async function verifySharedWorldPostcondition(
  pool: pg.Pool,
  store: Pick<Store, "getDeployment" | "getRelease" | "attestReleaseWorkflow">,
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

export type CutoverFinalizeResult = {
  finalized: string[];
  refused: Array<{ deploymentId: string; reason: string }>;
  /** Staged deployments not yet finalized; the operation stays retryable. */
  pendingStaged: string[];
  completed: boolean;
};

/**
 * Step 15's tail: after the cross-Release continuity gate has passed on the
 * resumed dispatcher, finalize the staged deployments to `external`.
 *
 * This is a gate, not a setter: the operation must exist and have reached
 * control-plane convergence, the database postcondition must hold RIGHT NOW,
 * and each Deployment must be `converting` under this exact operation. A typo
 * or stale invocation refuses instead of promoting an unclassified Deployment.
 */
export async function finalizeSharedWorldCutover(input: {
  pool: pg.Pool;
  store: CutoverStore;
  operationId: string;
  deploymentIds: string[];
  /**
   * The operator's explicit statement that the cross-Release continuity gate
   * passed on the resumed dispatcher. Recorded as a durable checkpoint; the
   * operation cannot complete without it.
   */
  continuityVerified?: boolean;
}): Promise<CutoverFinalizeResult> {
  const operation = await input.store.getWorkflowCutoverOperation(input.operationId);
  if (!operation) {
    throw new Error(`Cutover operation ${input.operationId} does not exist; nothing to finalize.`);
  }
  if (operation.phase !== "control_plane_converged" && operation.phase !== "completed") {
    throw new Error(
      `Cutover operation ${input.operationId} is ${operation.phase}; finalize requires control-plane convergence first.`,
    );
  }
  const postcondition = await verifySharedWorldPostcondition(input.pool, input.store);
  if (!postcondition.passed) {
    throw new Error(
      `The shared-world postcondition does not hold (${String(postcondition.claimableUnscopedJobs)} unscoped job(s), ${String(postcondition.blockingRuns.length)} blocking run(s)); finalize refused.`,
    );
  }
  if (input.continuityVerified) {
    await input.store.advanceWorkflowCutoverOperation(input.operationId, {
      checkpoint: { key: "continuity", value: { verifiedAt: new Date().toISOString() } },
    });
  }
  const finalized: string[] = [];
  const refused: CutoverFinalizeResult["refused"] = [];
  for (const deploymentId of input.deploymentIds) {
    const deployment = await input.store.getDeployment(deploymentId);
    if (!deployment) {
      refused.push({ deploymentId, reason: "deployment does not exist" });
      continue;
    }
    const { conversionState, conversionOperationId } = deployment.workflowTopology;
    if (conversionState === "external" && conversionOperationId === input.operationId) {
      finalized.push(deploymentId); // idempotent re-run
      continue;
    }
    if (conversionState !== "converting" || conversionOperationId !== input.operationId) {
      refused.push({
        deploymentId,
        reason: `deployment is ${conversionState} under operation ${String(conversionOperationId)}, not converting under ${input.operationId}`,
      });
      continue;
    }
    const updated = await input.store.updateDeploymentWorkflowTopology(deploymentId, {
      conversionState: "external",
      conversionOperationId: input.operationId,
      convertedAt: new Date().toISOString(),
    });
    if (updated) finalized.push(deploymentId);
  }
  // Completion is earned, not assumed: every deployment the operation staged
  // must be finalized, nothing may have been refused in this call, and the
  // continuity gate must be durably recorded. Anything less leaves the saga
  // at control-plane convergence, retryable.
  const current = await input.store.getWorkflowCutoverOperation(input.operationId);
  const stagedSet = Array.isArray(current?.checkpoints.staged)
    ? (current.checkpoints.staged as string[])
    : [];
  const pending: string[] = [];
  for (const deploymentId of stagedSet) {
    const deployment = await input.store.getDeployment(deploymentId);
    if (deployment?.workflowTopology.conversionState !== "external") pending.push(deploymentId);
  }
  const continuityRecorded = current?.checkpoints.continuity !== undefined;
  if (refused.length === 0 && pending.length === 0 && continuityRecorded) {
    await input.store.advanceWorkflowCutoverOperation(input.operationId, {
      phase: "completed",
      checkpoint: { key: "finalized", value: finalized },
    });
  } else {
    await input.store.advanceWorkflowCutoverOperation(input.operationId, {
      checkpoint: {
        key: "finalized",
        value: { finalized, refused, pendingStaged: pending, continuityRecorded },
      },
    });
  }
  return {
    finalized,
    refused,
    pendingStaged: pending,
    completed: refused.length === 0 && pending.length === 0 && continuityRecorded,
  };
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
