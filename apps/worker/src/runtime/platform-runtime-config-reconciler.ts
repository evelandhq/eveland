import type { Job } from "@evelandhq/core/contracts";
import type { Store } from "@evelandhq/db";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { RESERVED_RUNTIME_ENVIRONMENT_INPUTS } from "./reserved-environment.js";

/**
 * Carries a change to the platform's reserved runtime environment into the
 * Deployments that are already running with the old values (issue #477).
 *
 * `ensureProcess` reuses a unit that is already serving its port, which is the
 * right call on the cold-start path -- activation must not bounce a healthy
 * Agent -- but it is also the only path that would otherwise re-render the
 * environment. A Deployment that stays up across an operator's edit therefore
 * kept its launch-time values indefinitely, and every failure that followed
 * was partial and silent: the Agent answers HTTP, health is green, and only
 * the subsystem behind the changed value is broken. On UAT that was
 * EVELAND_WORKFLOW_WORLD_URL after a Postgres move; the same shape applies to
 * a rotated scheduler secret or a changed Identity issuer.
 *
 * The reconcile runs at worker boot, which is sound rather than merely
 * convenient: the reserved layer's inputs are read from the worker's own
 * environment, and that environment can only change by restarting the worker.
 * So every worker-environment drift passes through here exactly once. The
 * layer's other half -- shared Agent environment and project secrets, which
 * live in the database -- is already restarted from its own write paths.
 *
 * This generalizes what Identity configuration alone used to do. Identity got
 * a reconciler when it shipped and nothing added since was ever folded in,
 * which is the whole of the bug: the asymmetry was an accident, not a
 * judgment that the other names did not need it.
 */

const stateFileName = "platform-runtime-configuration.sha256";

/**
 * The Identity-only predecessor's state file. Removed when this reconciler
 * writes its own so a stale fingerprint of two variables does not sit next to
 * the real one looking authoritative.
 */
const legacyIdentityStateFileName = "identity-configuration.sha256";

/**
 * A stable digest of every worker-environment value the reserved layer reads.
 *
 * The pairs carry an explicit `null` for an unset variable: dropping the key
 * instead (as `JSON.stringify` does for `undefined`) would let "never set" and
 * "set to the empty string" collide, and those are different launches.
 *
 * Values, not just names, go into the digest -- including
 * EVELAND_SCHEDULER_RUNTIME_SECRET. Only the digest is ever written down, to a
 * 0600 file, and nothing reverses it back to a secret.
 */
export function platformRuntimeConfigurationFingerprint(env: NodeJS.ProcessEnv): string {
  const inputs = RESERVED_RUNTIME_ENVIRONMENT_INPUTS.map(
    (name) => [name, env[name] ?? null] as const,
  );
  return createHash("sha256").update(JSON.stringify(inputs)).digest("hex");
}

export type PlatformRuntimeConfigReconcilerStore = Pick<
  Store,
  "listProjects" | "listDeployments" | "enqueueJob"
>;

/**
 * Restarts every live Deployment when the reserved layer's inputs have changed
 * since the last boot, and records the new fingerprint. Returns the restart
 * jobs it queued -- empty when nothing changed, which is the common case.
 *
 * A first boot with no recorded fingerprint restarts the fleet once. That is
 * deliberate: the alternative (seed silently) would leave exactly the already
 * drifted Deployments this exists to rescue running on stale values, and the
 * state file lives with the data root, so it happens once per install rather
 * than once per upgrade.
 */
export async function reconcilePlatformRuntimeConfiguration(
  store: PlatformRuntimeConfigReconcilerStore,
  input: { dataDir: string; env?: NodeJS.ProcessEnv },
): Promise<Job[]> {
  const fingerprint = platformRuntimeConfigurationFingerprint(input.env ?? process.env);
  const stateDir = path.join(input.dataDir, "runtime-state");
  const statePath = path.join(stateDir, stateFileName);
  const previous = await readFile(statePath, "utf8").catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  if (previous.trim() === fingerprint) return [];

  const jobs: Job[] = [];
  for (const project of await store.listProjects()) {
    for (const deployment of await store.listDeployments(project.id)) {
      // A stopped Deployment composes a fresh environment when it next cold
      // activates, so only the ones holding a launched process need this.
      if (deployment.status !== "running" && deployment.status !== "draining") continue;
      jobs.push(
        await store.enqueueJob(project.id, "restart_deployment", {
          deploymentId: deployment.id,
          reason: "platform_runtime_configuration_changed",
        }),
      );
    }
  }

  await mkdir(stateDir, { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${fingerprint}\n`, { mode: 0o600 });
  await rename(temporaryPath, statePath);
  await rm(path.join(stateDir, legacyIdentityStateFileName), { force: true });
  return jobs;
}
