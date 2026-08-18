import { isSupportedWorkflowStorageSpec } from "@evelandhq/core/workflow-dispatch";
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
import {
  terminateLegacyProjectRuns,
  type LegacyWorldTermination,
  type LegacyWorldTerminator,
} from "./legacy-world-termination.js";

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
  | "getActiveWorkflowFence"
  | "convergeWorkflowTermination"
  | "convergeWorkflowRunFamilies"
  | "updateDeploymentWorkflowTopology"
  | "measureCutoverQuiescence"
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
      if (
        release.workflow.worldKind === "shared" &&
        !isSupportedWorkflowStorageSpec(release.workflow.storageSpec)
      ) {
        // Protocol and storage are independent axes: an owner can speak the
        // current dispatch protocol over an event log written under a storage
        // generation nothing here can read.
        classification = "managed_termination_required";
        ownerRetired = true;
        reasons.push(
          `owner Release ${release.id} storage spec ${String(release.workflow.storageSpec)} is outside the supported window`,
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
  /** Legacy per-project Worlds terminated (or found already gone). */
  legacyWorlds: LegacyWorldTermination[];
  staged: string[];
  converged: { failedSessions: number; removedSessionBindings: number };
  /** Terminated runs whose Eve family could not be proven; operator must map them. */
  unmappedTerminatedRuns: Array<{ tenantId: string; runId: string }>;
  /**
   * Why the saga did NOT advance this run. Empty means the operation reached
   * control-plane convergence and staging; anything here holds it at the
   * current phase, retryable after the operator resolves the cause.
   */
  holds: string[];
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
  /**
   * Operator assertion that a terminated run projected no Eve session family
   * (e.g. a run created via the API with telemetry disabled). Recorded as a
   * durable checkpoint; without a mapping or this assertion, a terminated run
   * BLOCKS convergence and completion.
   */
  runsWithoutFamilies?: Array<{ tenantId: string; runId: string }>;
  /**
   * The legacy per-project World estate. `baseUrl` is WORKFLOW_POSTGRES_URL;
   * leaving it undefined while legacy owners exist is a hold, not a pass —
   * their runs live in databases this command would then be unable to reach.
   */
  legacyWorlds?: { baseUrl: string | undefined; terminate?: LegacyWorldTerminator };
  /**
   * The operator's formal attestation that every producer/consumer is stopped
   * and the rollback backups were taken AFTER quiescence. The attestation is
   * VERIFIED, not trusted: it records only while a double-read measurement of
   * the control plane and the World shows zero live activity and stable
   * sequences, and the measured baseline is persisted with it. Every later
   * prepare re-validates the baseline — protected sequences advancing after
   * the backup invalidate the boundary and hold the saga until the operator
   * re-attests over fresh backups. Without a valid recorded boundary, prepare
   * mutates NOTHING.
   */
  maintenance?: { quiescenceVerified: boolean; backupEvidence: string };
  /** Settle interval between the two quiescence reads (default 1500ms). */
  quiescenceSettleMs?: number;
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

    // The maintenance boundary is a fail-closed gate, not a runbook note —
    // and the attestation is measured, never merely trusted.
    const maintenanceHold = await enforceMaintenanceBoundary(pool, store, operationId, {
      ...(input.maintenance ? { maintenance: input.maintenance } : {}),
      settleMs: input.quiescenceSettleMs ?? 1_500,
      log,
    });
    if (maintenanceHold) {
      await store.advanceWorkflowCutoverOperation(operationId, { lastError: maintenanceHold });
      return {
        operationId,
        assessments: [],
        migration: { scoped: 0, parked: 0, backfilledNamespaces: 0 },
        terminated: [],
        quarantined: [],
        retiredDeployments: [],
        fencedUnknownDeployments: [],
        legacyWorlds: [],
        staged: await readStagedCheckpoint(store, operationId),
        converged: { failedSessions: 0, removedSessionBindings: 0 },
        unmappedTerminatedRuns: [],
        holds: [maintenanceHold],
      };
    }

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
    const legacyProjects = new Set<string>();
    for (const project of await store.listProjects()) {
      for (const deployment of await store.listDeployments(project.id)) {
        // Archived rows are still retained rows: the OTLP projector accepts
        // them, so they classify and fence like live ones — they just never
        // stage (an archived Deployment has no runtime future to convert).
        const archived = deployment.status === "archived";
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
        const { worldKind, enqueueCapability, dispatchProtocol, storageSpec } = release.workflow;
        if (worldKind === "legacy_project") legacyProjects.add(project.id);
        // The full compatibility decision — capability, dispatch-protocol
        // window AND storage generation — applies to every retained
        // Deployment, active run or not. An idle incompatible owner that
        // staged here would finalize as `external` while the activation path
        // rejects its every workflow.
        const outsideWindow =
          dispatchProtocol === null ||
          dispatchProtocol > DISPATCH_VERSION ||
          !isSupportedWorkflowStorageSpec(storageSpec);
        if (
          worldKind === "legacy_project" ||
          (worldKind === "shared" && (enqueueCapability !== "per_run_queue_v1" || outsideWindow))
        ) {
          inventoryRetired.push(deployment.id);
        } else if (worldKind === "unknown") {
          inventoryUnknown.push(deployment.id);
        } else if (
          !archived &&
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
      // Quarantine BEFORE cancel: the durable marker is the identity record a
      // retry seeds family convergence from. In the other order, a crash
      // between the two leaves a cancelled run that no longer shows up as
      // active AND has no marker — invisible to every later pass.
      await quarantineRun(pool, workerUtils, {
        ...target,
        operationId,
        reason: assessment.reasons.join("; ") || assessment.classification,
      });
      quarantined.push(target);
      const cancelled = await cancelRunDirectly(pool, target);
      if (cancelled) {
        terminated.push(target);
      }
      log("managed termination staged", { ...target, cancelled });
    }

    // In-place migration for provable early-external jobs (owners already
    // attested per_run_queue_v1 — anything else was terminated above).
    const migration = await migrateUnscopedRunJobs(pool, { log });

    const partialResult = {
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
    };

    // Legacy Worlds hold real runs in per-project databases this command's
    // shared pool never touches. Retiring their owners in the control plane
    // is not workflow safety — every one of those runs must be cancelled in
    // its own database, or the saga holds at `fenced`. No base URL while
    // legacy owners exist is a hold too, never a pass.
    const legacyWorlds: LegacyWorldTermination[] = [];
    const legacyHolds: string[] = [];
    if (legacyProjects.size > 0) {
      const baseUrl = input.legacyWorlds?.baseUrl;
      const terminate = input.legacyWorlds?.terminate ?? terminateLegacyProjectRuns;
      if (!baseUrl) {
        legacyHolds.push(
          `${String(legacyProjects.size)} project(s) own legacy Worlds but no WORKFLOW_POSTGRES_URL was provided to terminate them`,
        );
      } else {
        for (const projectId of legacyProjects) {
          try {
            const termination = await terminate(baseUrl, projectId);
            legacyWorlds.push(termination);
            if (termination.remainingActiveRuns > 0) {
              legacyHolds.push(
                `legacy World ${termination.database ?? projectId} still has ${String(termination.remainingActiveRuns)} active run(s) after cancellation`,
              );
            }
            log("legacy World terminated", { ...termination });
          } catch (error) {
            legacyHolds.push(
              `legacy World termination failed for project ${projectId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    }
    if (legacyHolds.length > 0) {
      await store.advanceWorkflowCutoverOperation(operationId, {
        lastError: legacyHolds.join("; "),
      });
      return {
        ...partialResult,
        legacyWorlds,
        staged: await readStagedCheckpoint(store, operationId),
        converged: { failedSessions: 0, removedSessionBindings: 0 },
        unmappedTerminatedRuns: [],
        holds: legacyHolds,
      };
    }

    await store.advanceWorkflowCutoverOperation(operationId, {
      phase: "workflow_safe",
      checkpoint: {
        key: "workflow_safe",
        value: {
          terminated: terminated.length,
          quarantined: quarantined.length,
          migratedJobs: migration.scoped,
          parkedJobs: migration.parked.length,
          legacyWorlds: legacyWorlds.map((entry) => ({
            projectId: entry.projectId,
            database: entry.database,
            cancelledRuns: entry.cancelledRuns,
          })),
        },
      },
    });

    // Control-plane convergence — deployment-wide for the permanently retired
    // owners, and per-family for individually terminated runs whose Eve
    // family the operator proved. Unproven families are named, not guessed.
    const converged = await store.convergeWorkflowTermination(operationId, retiredDeployments);
    const retired = new Set(retiredDeployments);
    // Permanently retired owners reach their terminal topology here: archive
    // explicitly permits only `external` or `terminated`, so leaving them at
    // their previous non-terminal state would make their artifacts
    // unarchivable forever.
    for (const deploymentId of retiredDeployments) {
      await store.updateDeploymentWorkflowTopology(deploymentId, {
        conversionState: "terminated",
        conversionOperationId: operationId,
      });
    }

    // The disposition ledger is durable ON PURPOSE: a terminated run is
    // cancelled on the first pass and never shows up as active again, so
    // mappings and assertions supplied on a retry must land against the
    // persisted identities, not against the (now empty) live assessment.
    const dispositions = await readFamilyDispositions(store, operationId);
    for (const entry of input.runSessionFamilies ?? []) {
      dispositions[`${entry.tenantId}:${entry.runId}`] = {
        kind: "mapped",
        projectId: entry.tenantId,
        eveSessionId: entry.eveSessionId,
      };
    }
    for (const run of input.runsWithoutFamilies ?? []) {
      dispositions[`${run.tenantId}:${run.runId}`] = { kind: "asserted_no_family" };
    }

    // The worklist is seeded from BOTH this call's live assessment and every
    // unresolved quarantine this operation wrote on an earlier pass — the
    // quarantine-before-cancel ordering above guarantees a terminated run is
    // always in at least one of the two.
    const worklist = new Map<
      string,
      { tenantId: string; runId: string; deploymentId: string | null }
    >();
    for (const assessment of nonRecoverable) {
      worklist.set(`${assessment.tenantId}:${assessment.runId}`, {
        tenantId: assessment.tenantId,
        runId: assessment.runId,
        deploymentId: assessment.deploymentId,
      });
    }
    for (const quarantine of await listUnresolvedRunQuarantines(pool)) {
      if (quarantine.operationId !== operationId) continue;
      const key = `${quarantine.tenantId}:${quarantine.runId}`;
      if (worklist.has(key)) continue;
      const { rows } = await pool.query<{ deployment_id: string | null }>(
        `select deployment_id from workflow.workflow_runs where tenant_id = $1 and id = $2`,
        [quarantine.tenantId, quarantine.runId],
      );
      worklist.set(key, {
        tenantId: quarantine.tenantId,
        runId: quarantine.runId,
        deploymentId: rows[0]?.deployment_id ?? null,
      });
    }

    const mappedFamilies: Array<{ projectId: string; eveSessionId: string }> = [];
    const acceptedWithoutFamily: Array<{ tenantId: string; runId: string }> = [];
    const unmappedTerminatedRuns: Array<{ tenantId: string; runId: string }> = [];
    for (const entry of worklist.values()) {
      // Deployment-wide convergence already tombstones every named family on
      // a permanently retired owner — retired in this call, or provably
      // terminal (`terminated`) from an earlier one. A temporary
      // unknown-topology fence is NOT convergence: the operator may later
      // classify the owner and resolve that fence, and a family that was
      // skipped because of it would have no tombstone against late OTLP.
      if (entry.deploymentId) {
        if (retired.has(entry.deploymentId)) continue;
        const owner = await store.getDeployment(entry.deploymentId);
        if (owner?.workflowTopology.conversionState === "terminated") continue;
      }
      const disposition = dispositions[`${entry.tenantId}:${entry.runId}`];
      if (disposition?.kind === "mapped") {
        mappedFamilies.push({
          projectId: disposition.projectId,
          eveSessionId: disposition.eveSessionId,
        });
      } else if (disposition?.kind === "asserted_no_family") {
        acceptedWithoutFamily.push({ tenantId: entry.tenantId, runId: entry.runId });
      } else {
        unmappedTerminatedRuns.push({ tenantId: entry.tenantId, runId: entry.runId });
      }
    }
    // Converge every mapped family (idempotent), and persist the ledger even
    // on a hold: partial mappings supplied so far must survive the retry.
    const familyConvergence = await store.convergeWorkflowRunFamilies(operationId, mappedFamilies);
    await store.advanceWorkflowCutoverOperation(operationId, {
      checkpoint: { key: "familyDispositions", value: dispositions },
    });
    if (unmappedTerminatedRuns.length > 0) {
      // The World postcondition passes for these runs (they are quarantined),
      // so this is the ONLY gate that notices a missing tombstone. Blocking
      // here — not just reporting — is what keeps a late OTLP batch from
      // reopening exactly the family that was terminated.
      const hold = `${String(unmappedTerminatedRuns.length)} terminated run(s) have no proven Eve family; map them with --run-families or assert --no-family`;
      log("terminated runs without a proven Eve family; operator mapping required", {
        runs: unmappedTerminatedRuns.length,
      });
      await store.advanceWorkflowCutoverOperation(operationId, {
        lastError: hold,
        checkpoint: { key: "unresolvedFamilies", value: unmappedTerminatedRuns },
      });
      return {
        ...partialResult,
        legacyWorlds,
        staged: await readStagedCheckpoint(store, operationId),
        converged: {
          failedSessions: converged.failedSessions,
          removedSessionBindings: converged.removedSessionBindings,
        },
        unmappedTerminatedRuns,
        holds: [hold],
      };
    }
    await store.advanceWorkflowCutoverOperation(operationId, {
      phase: "control_plane_converged",
      checkpoint: {
        key: "converged",
        value: {
          ...converged,
          runFamilies: familyConvergence,
          acceptedWithoutFamily,
        },
      },
    });
    // Every terminated run is now mapped or explicitly asserted family-less;
    // clear the blocking checkpoint a previous partial run may have written.
    await store.advanceWorkflowCutoverOperation(operationId, {
      checkpoint: { key: "unresolvedFamilies", value: [] },
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
    // only once every one of these has actually finalized. It only ever
    // GROWS — a rerun no longer re-observes deployments it already staged
    // (they are `converting`, not `unclassified`), and overwriting would let
    // finalize complete while one of them still converts.
    const stagedUnion = [
      ...new Set([...(await readStagedCheckpoint(store, operationId)), ...staged]),
    ];
    await store.advanceWorkflowCutoverOperation(operationId, {
      checkpoint: { key: "staged", value: stagedUnion },
    });

    return {
      ...partialResult,
      legacyWorlds,
      staged: stagedUnion,
      converged: {
        failedSessions: converged.failedSessions,
        removedSessionBindings: converged.removedSessionBindings,
      },
      unmappedTerminatedRuns,
      holds: [],
    };
  } finally {
    await Promise.resolve(workerUtils.release()).catch(() => {});
  }
}

type MaintenanceBaseline = {
  attestedAt: string;
  backupEvidence: string;
  worldRunCount: number;
  latestSessionStartedAt: string | null;
  latestJobSequence: number;
};

type QuiescenceReading = {
  lockedWorldJobs: number;
  worldRunCount: number;
  runningJobs: number;
  activeActivationLeases: number;
  latestSessionStartedAt: string | null;
  latestJobSequence: number;
};

async function readQuiescence(
  pool: pg.Pool,
  store: Pick<Store, "measureCutoverQuiescence">,
): Promise<QuiescenceReading> {
  const { rows } = await pool.query<{ locked: number; runs: number }>(
    `select (select count(*)::int from graphile_worker._private_jobs where locked_by is not null) as locked,
            (select count(*)::int from workflow.workflow_runs) as runs`,
  );
  const control = await store.measureCutoverQuiescence();
  return {
    lockedWorldJobs: rows[0]?.locked ?? 0,
    worldRunCount: rows[0]?.runs ?? 0,
    runningJobs: control.runningJobs,
    activeActivationLeases: control.activeActivationLeases,
    latestSessionStartedAt: control.latestSessionStartedAt,
    latestJobSequence: control.latestJobSequence,
  };
}

function liveActivity(reading: QuiescenceReading): string[] {
  const live: string[] = [];
  if (reading.lockedWorldJobs > 0)
    live.push(`${String(reading.lockedWorldJobs)} locked World job(s)`);
  if (reading.runningJobs > 0) live.push(`${String(reading.runningJobs)} running platform job(s)`);
  if (reading.activeActivationLeases > 0)
    live.push(`${String(reading.activeActivationLeases)} active activation lease(s)`);
  return live;
}

/**
 * Returns a hold message when the maintenance boundary is not (or no longer)
 * valid; null when mutation may proceed.
 *
 * Recording requires the operator's flags AND a measured double-read showing
 * zero live activity with stable sequences; the measured baseline persists
 * with the attestation. Validation re-measures on every later prepare:
 * protected sequences advancing past the baseline — new runs, new sessions,
 * new jobs the operation's own stamp cannot explain — mean something wrote
 * AFTER the backup, so the recorded boundary is invalidated and the saga
 * holds until the operator re-attests over fresh backups.
 */
async function enforceMaintenanceBoundary(
  pool: pg.Pool,
  store: CutoverStore,
  operationId: string,
  input: {
    maintenance?: { quiescenceVerified: boolean; backupEvidence: string };
    settleMs: number;
    log: (message: string, meta?: Record<string, unknown>) => void;
  },
): Promise<string | null> {
  const operation = await store.getWorkflowCutoverOperation(operationId);
  const recorded = operation?.checkpoints.maintenance as
    | ({ quiescenceVerified?: boolean } & Partial<MaintenanceBaseline>)
    | undefined;
  const flagsSupplied =
    input.maintenance?.quiescenceVerified === true && input.maintenance.backupEvidence.length > 0;

  const recordedValid =
    recorded?.quiescenceVerified === true &&
    typeof recorded.backupEvidence === "string" &&
    typeof recorded.attestedAt === "string" &&
    typeof recorded.latestJobSequence === "number";

  if (recordedValid && !flagsSupplied) {
    // Validate the standing boundary: the backup is only a rollback point
    // while nothing has written since it was taken.
    const current = await readQuiescence(pool, store);
    const foreign = await store.measureCutoverQuiescence({
      sinceSequence: recorded.latestJobSequence!,
      excludeOperationId: operationId,
    });
    const violations = liveActivity(current);
    if (current.worldRunCount > (recorded.worldRunCount ?? 0)) {
      violations.push(
        `${String(current.worldRunCount - (recorded.worldRunCount ?? 0))} workflow run(s) created after the backup`,
      );
    }
    if (
      current.latestSessionStartedAt !== null &&
      (recorded.latestSessionStartedAt === null ||
        recorded.latestSessionStartedAt === undefined ||
        current.latestSessionStartedAt > recorded.latestSessionStartedAt)
    ) {
      if (recorded.latestSessionStartedAt !== current.latestSessionStartedAt) {
        violations.push("platform Session(s) created after the backup");
      }
    }
    if (foreign.foreignJobsSince > 0) {
      violations.push(
        `${String(foreign.foreignJobsSince)} platform job(s) not stamped by this operation created after the backup`,
      );
    }
    if (violations.length > 0) {
      await store.advanceWorkflowCutoverOperation(operationId, {
        checkpoint: {
          key: "maintenanceViolation",
          value: { at: new Date().toISOString(), violations },
        },
      });
      return `maintenance boundary invalidated — writes after the recorded backup (${violations.join("; ")}); take fresh quiesced backups and re-attest with --quiescence-verified true --backup-evidence <ids>`;
    }
    return null;
  }

  if (!flagsSupplied) {
    return "maintenance boundary not attested: stop every producer/consumer, take the formal backups, then supply --quiescence-verified true and --backup-evidence <snapshot ids>";
  }

  // (Re-)attestation: measure quiescence with a double read — zero live
  // activity and stable sequences across the settle interval — before the
  // operator's statement is accepted and the baseline recorded.
  const first = await readQuiescence(pool, store);
  await new Promise((resolve) => setTimeout(resolve, input.settleMs));
  const second = await readQuiescence(pool, store);
  const problems = [...new Set([...liveActivity(first), ...liveActivity(second)])];
  if (
    first.worldRunCount !== second.worldRunCount ||
    first.latestJobSequence !== second.latestJobSequence ||
    first.latestSessionStartedAt !== second.latestSessionStartedAt
  ) {
    problems.push("protected sequences advanced during the settle interval");
  }
  if (problems.length > 0) {
    return `quiescence not measured — the system is still live (${problems.join("; ")}); stop every producer/consumer before attesting the maintenance boundary`;
  }
  const baseline: MaintenanceBaseline = {
    attestedAt: new Date().toISOString(),
    backupEvidence: input.maintenance!.backupEvidence,
    worldRunCount: second.worldRunCount,
    latestSessionStartedAt: second.latestSessionStartedAt,
    latestJobSequence: second.latestJobSequence,
  };
  await store.advanceWorkflowCutoverOperation(operationId, {
    checkpoint: {
      key: "maintenance",
      value: { quiescenceVerified: true, ...baseline },
    },
  });
  input.log("maintenance boundary attested over a measured-quiescent system", { ...baseline });
  return null;
}

async function readStagedCheckpoint(
  store: Pick<Store, "getWorkflowCutoverOperation">,
  operationId: string,
): Promise<string[]> {
  const operation = await store.getWorkflowCutoverOperation(operationId);
  return Array.isArray(operation?.checkpoints.staged)
    ? (operation.checkpoints.staged as string[])
    : [];
}

/**
 * Whether recording a PASSED World-visible proof for this operation is
 * honest. The database postcondition alone inspects only shared-World rows
 * and claimable jobs — a freshly created `pending` operation over an empty
 * shared World would "pass" while legacy Worlds are still live and nothing
 * was ever fenced or converged. The proof the dispatcher trusts must carry
 * the whole story: prepare reached control-plane convergence with no
 * unresolved family dispositions.
 */
export async function assessCutoverProofEligibility(
  store: Pick<Store, "getWorkflowCutoverOperation">,
  operationId: string,
): Promise<{ eligible: boolean; reasons: string[] }> {
  const operation = await store.getWorkflowCutoverOperation(operationId);
  const reasons: string[] = [];
  if (!operation) {
    reasons.push(`cutover operation ${operationId} does not exist`);
  } else {
    if (operation.phase !== "control_plane_converged" && operation.phase !== "completed") {
      reasons.push(
        `operation is ${operation.phase}; prepare must reach control-plane convergence before a passing proof`,
      );
    }
    const unresolved = Array.isArray(operation.checkpoints.unresolvedFamilies)
      ? operation.checkpoints.unresolvedFamilies.length
      : 0;
    if (unresolved > 0) {
      reasons.push(`${String(unresolved)} terminated run(s) still lack a family disposition`);
    }
  }
  return { eligible: reasons.length === 0, reasons };
}

type FamilyDisposition =
  | { kind: "mapped"; projectId: string; eveSessionId: string }
  | { kind: "asserted_no_family" };

async function readFamilyDispositions(
  store: Pick<Store, "getWorkflowCutoverOperation">,
  operationId: string,
): Promise<Record<string, FamilyDisposition>> {
  const operation = await store.getWorkflowCutoverOperation(operationId);
  const value = operation?.checkpoints.familyDispositions;
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, FamilyDisposition>) }
    : {};
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
  // A run of `prepare` that terminated runs without a proven Eve family
  // records them here and holds. Belt and braces: even if the phase somehow
  // advanced, an unresolved family blocks completion — the missing tombstone
  // is exactly what a late OTLP batch would exploit.
  const unresolvedFamilies = Array.isArray(current?.checkpoints.unresolvedFamilies)
    ? current.checkpoints.unresolvedFamilies.length
    : 0;
  const completed =
    refused.length === 0 && pending.length === 0 && continuityRecorded && unresolvedFamilies === 0;
  if (completed) {
    await input.store.advanceWorkflowCutoverOperation(input.operationId, {
      phase: "completed",
      checkpoint: { key: "finalized", value: finalized },
    });
  } else {
    await input.store.advanceWorkflowCutoverOperation(input.operationId, {
      checkpoint: {
        key: "finalized",
        value: {
          finalized,
          refused,
          pendingStaged: pending,
          continuityRecorded,
          unresolvedFamilies,
        },
      },
    });
  }
  return {
    finalized,
    refused,
    pendingStaged: pending,
    completed,
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
