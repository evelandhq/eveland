import { createStoreFromEnv } from "@evelandhq/db/factory";
import pg from "pg";
import { resolveWorkflowWorldPlatformUrl } from "../runtime/eveland-workflow-world-url.js";
import {
  assessSharedActiveRuns,
  finalizeSharedWorldCutover,
  prepareSharedWorldCutover,
  verifySharedWorldPostcondition,
} from "./shared-world-cutover.js";

/**
 * The idempotent maintenance-downtime cutover command. Every subcommand prints
 * a machine-readable JSON report of exactly which objects are unclassified,
 * unterminated or blocking readiness — an operator never has to infer state
 * from logs. Run it only inside the full maintenance window with every
 * producer/consumer stopped; it does not verify quiescence itself.
 *
 *   pnpm --filter @evelandhq/worker cutover -- inventory --operation-id cut_x
 *   pnpm --filter @evelandhq/worker cutover -- prepare --operation-id cut_x
 *   pnpm --filter @evelandhq/worker cutover -- postcondition
 *   pnpm --filter @evelandhq/worker cutover -- finalize --operation-id cut_x --deployments dep_a,dep_b
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
          log: (message, meta) =>
            console.error(`[cutover] ${message} ${JSON.stringify(meta ?? {})}`),
        });
        emit({ command, ...result });
        return;
      }
      case "postcondition": {
        const result = await verifySharedWorldPostcondition(pool, store);
        emit({ command, ...result });
        if (!result.passed) process.exitCode = 1;
        return;
      }
      case "finalize": {
        if (!operationId) fail("finalize requires --operation-id.");
        const deployments = (flags.deployments ?? "")
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean);
        if (deployments.length === 0) fail("finalize requires --deployments dep_a,dep_b.");
        const finalized = await finalizeSharedWorldCutover({
          store,
          operationId: operationId!,
          deploymentIds: deployments,
        });
        emit({ command, finalized });
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
