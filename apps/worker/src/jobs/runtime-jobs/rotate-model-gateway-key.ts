import type { Store } from "@evelandhq/db";

import {
  rotateProjectModelGatewayKey,
  type ModelGatewayEnvironmentStore,
} from "../model-gateway-environment.js";
import { devSecretKey } from "../process-support.js";
import type { ProcessJobOptions } from "../process-types.js";
import type { RuntimeJob } from "./types.js";

type RotateModelGatewayKeyStore = Pick<Store, "appendLog" | "enqueueJob" | "listDeployments"> &
  ModelGatewayEnvironmentStore;

/**
 * Replaces the project's issued Model Gateway key, then restarts its live
 * Deployments so they pick the new key up. The gateway keeps the old key
 * valid for a grace period, so the restarts never leave a Deployment without
 * a working key.
 */
export async function handleRotateModelGatewayKeyJob(
  store: RotateModelGatewayKeyStore,
  job: RuntimeJob<"rotate_model_gateway_key">,
  options: ProcessJobOptions,
): Promise<void> {
  const result = await rotateProjectModelGatewayKey(store, job.projectId, {
    appSecretKey: options.appSecretKey ?? process.env.APP_SECRET_KEY ?? devSecretKey,
    ...(options.modelGatewayKeyClient ? { client: options.modelGatewayKeyClient } : {}),
  });
  if (result.status === "nothing-to-rotate") {
    await store.appendLog({
      projectId: job.projectId,
      type: "deploy",
      line: "No Model Gateway key to rotate: this project has no key issued on the current gateway. One is issued on its next deploy or restart.",
    });
    return;
  }

  const live = (await store.listDeployments(job.projectId)).filter(
    (deployment) => deployment.status === "running" || deployment.status === "draining",
  );
  for (const deployment of live) {
    await store.enqueueJob(job.projectId, "restart_deployment", {
      deploymentId: deployment.id,
      reason: "model_gateway_key_rotated",
    });
  }
  await store.appendLog({
    projectId: job.projectId,
    type: "deploy",
    line: `Rotated this project's Model Gateway key; restarting ${live.length} live deployment(s) onto the new key.`,
  });
}
