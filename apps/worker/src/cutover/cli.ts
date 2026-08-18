import { createStoreFromEnv } from "@evelandhq/db/factory";
import { recordCutoverProof } from "@evelandhq/workflow-world";
import pg from "pg";
import { resolveWorkflowWorldPlatformUrl } from "../runtime/eveland-workflow-world-url.js";
import { resolveBootstrapPostgresUrl } from "../runtime/workflow-world-bootstrap.js";
import {
  assessCutoverProofEligibility,
  assessSharedActiveRuns,
  finalizeSharedWorldCutover,
  prepareSharedWorldCutover,
  verifySharedWorldPostcondition,
} from "./shared-world-cutover.js";

/**
 * The idempotent maintenance-downtime cutover command. Every subcommand prints
 * a machine-readable JSON report of exactly which objects are unclassified,
 * unterminated or blocking readiness — an operator never has to infer state
 * from logs. Run it only inside the full maintenance window: `prepare`
 * refuses to mutate anything until the operator's quiescence-and-backup
 * attestation is durably recorded on the operation.
 *
 *   pnpm --filter @evelandhq/worker cutover -- inventory --operation-id cut_x
 *   pnpm --filter @evelandhq/worker cutover -- prepare --operation-id cut_x \
 *     --quiescence-verified true --backup-evidence <snapshot ids> \
 *     [--corrupted-runs tenant:run,...] [--run-families tenant:run:eveSessionId,...] \
 *     [--no-family tenant:run,...]
 *   pnpm --filter @evelandhq/worker cutover -- postcondition --operation-id cut_x
 *   pnpm --filter @evelandhq/worker cutover -- finalize --operation-id cut_x \
 *     --deployments dep_a,dep_b --continuity-verified true
 */
async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const operationId = flags["operation-id"] ?? process.env.EVELAND_WORKFLOW_CUTOVER_OPERATION_ID;

  const worldUrl = resolveWorkflowWorldPlatformUrl(process.env);
  if (!worldUrl) {
    fail(
      "EVELAND_WORKFLOW_WORLD_URL is required: the cutover operates on the shared workflow world.",
    );
  }
  const storeFactory = createStoreFromEnv();
  const pool = new pg.Pool({ connectionString: worldUrl, max: 4 });
  try {
    const store = storeFactory.store;
    switch (command) {
      case "inventory": {
        const assessments = await assessSharedActiveRuns(pool, store);
        emit({ command, assessments });
        return;
      }
      case "prepare": {
        if (!operationId)
          fail("prepare requires --operation-id (or EVELAND_WORKFLOW_CUTOVER_OPERATION_ID).");
        const result = await prepareSharedWorldCutover({
          pool,
          store,
          operationId: operationId!,
          ...(flags["corrupted-runs"]
            ? { corruptedRuns: parseRunList(flags["corrupted-runs"]!) }
            : {}),
          ...(flags["run-families"]
            ? { runSessionFamilies: parseFamilyList(flags["run-families"]!) }
            : {}),
          ...(flags["no-family"] ? { runsWithoutFamilies: parseRunList(flags["no-family"]!) } : {}),
          maintenance: {
            quiescenceVerified: flags["quiescence-verified"] === "true",
            backupEvidence: flags["backup-evidence"] ?? "",
          },
          // WORKFLOW_POSTGRES_URL is the Deployment-facing address and may
          // say host.docker.internal; this host process must connect the way
          // bootstrap and the reaper do, or every legacy World looks
          // unreachable and the cutover holds forever.
          legacyWorlds: {
            baseUrl: process.env.WORKFLOW_POSTGRES_URL
              ? resolveBootstrapPostgresUrl(process.env, process.env.WORKFLOW_POSTGRES_URL)
              : undefined,
          },
          log: (message, meta) =>
            console.error(`[cutover] ${message} ${JSON.stringify(meta ?? {})}`),
        });
        emit({ command, ...result });
        if (result.holds.length > 0) process.exitCode = 1;
        return;
      }
      case "postcondition": {
        const result = await verifySharedWorldPostcondition(pool, store);
        // The proof is World-visible on purpose: the dispatcher's recover-paused
        // preflight gates boot recovery on it and never reads the control-plane
        // database. A failed check is recorded too — a stale passed proof must
        // not outlive a regression. And a passing proof is EARNED: the database
        // postcondition alone would "pass" for a pending operation over an
        // empty shared World while legacy Worlds are still live, so the
        // operation must have reached control-plane convergence with no
        // unresolved family dispositions before `passed: true` is recorded.
        let proofPassed = result.passed;
        let eligibilityReasons: string[] = [];
        if (operationId) {
          const eligibility = await assessCutoverProofEligibility(store, operationId);
          eligibilityReasons = eligibility.reasons;
          proofPassed = result.passed && eligibility.eligible;
          await recordCutoverProof(pool, {
            operationId,
            passed: proofPassed,
            claimableUnscopedJobs: result.claimableUnscopedJobs,
            blockingRuns: result.blockingRuns.length,
            recordedBy: "eveland-cutover-cli",
          });
        }
        emit({
          command,
          ...result,
          proofRecorded: Boolean(operationId),
          proofPassed: operationId ? proofPassed : null,
          proofHolds: eligibilityReasons,
        });
        if (!result.passed || (operationId !== undefined && !proofPassed)) process.exitCode = 1;
        return;
      }
      case "finalize": {
        if (!operationId) fail("finalize requires --operation-id.");
        const deployments = (flags.deployments ?? "")
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean);
        if (deployments.length === 0) fail("finalize requires --deployments dep_a,dep_b.");
        const result = await finalizeSharedWorldCutover({
          pool,
          store,
          operationId: operationId!,
          deploymentIds: deployments,
          continuityVerified: flags["continuity-verified"] === "true",
        });
        emit({ command, ...result });
        if (!result.completed) process.exitCode = 1;
        return;
      }
      default:
        fail(
          `Unknown cutover command "${command ?? ""}". Use inventory | prepare | postcondition | finalize.`,
        );
    }
  } finally {
    await pool.end().catch(() => {});
    await storeFactory.close().catch(() => {});
  }
}

function parseRunList(value: string): Array<{ tenantId: string; runId: string }> {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [tenantId, runId] = entry.split(":");
      if (!tenantId || !runId) fail(`Invalid run "${entry}": expected tenant:run.`);
      return { tenantId: tenantId!, runId: runId! };
    });
}

function parseFamilyList(
  value: string,
): Array<{ tenantId: string; runId: string; eveSessionId: string }> {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [tenantId, runId, eveSessionId] = entry.split(":");
      if (!tenantId || !runId || !eveSessionId)
        fail(`Invalid family "${entry}": expected tenant:run:eveSessionId.`);
      return { tenantId: tenantId!, runId: runId!, eveSessionId: eveSessionId! };
    });
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const value = args[index + 1];
      if (value && !value.startsWith("--")) {
        flags[name] = value;
        index += 1;
      } else {
        flags[name] = "true";
      }
    }
  }
  return flags;
}

function emit(payload: Record<string, unknown>): void {
  console.log(JSON.stringify(payload, null, 2));
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

await main();
