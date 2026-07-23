import {
  createAgentRuntimePolicy,
  type AgentRuntimePolicy,
  type ObservabilityPolicy,
} from "@eveland/core/observability";
import {
  DEFAULT_TEAM_ID,
  type Store,
} from "@eveland/db";
import {
  resolveAgentObservabilityDirs,
  writeAgentRuntimePolicy,
} from "../runtime/observability-policy.js";
import type { RuntimeAdapter } from "../runtime/types.js";

export async function prepareDeploymentObservability(input: {
  store: Store;
  env: NodeJS.ProcessEnv;
  projectId: string;
  releaseId: string;
  deploymentId: string;
  runtimeKind: RuntimeAdapter["name"];
  nodeEnv?: string;
  policy?: ObservabilityPolicy;
}): Promise<{
  policy: AgentRuntimePolicy;
  workerDir: string;
  hostDir: string;
}> {
  const policy = createAgentRuntimePolicy({
    policy:
      input.policy ??
      (await input.store.getObservabilityPolicy(DEFAULT_TEAM_ID)),
    otlpEndpoint:
      input.runtimeKind === "docker"
        ? "http://host.docker.internal:4318"
        : "http://127.0.0.1:4318",
    resource: {
      teamId: DEFAULT_TEAM_ID,
      projectId: input.projectId,
      releaseId: input.releaseId,
      deploymentId: input.deploymentId,
      runtimeKind: input.runtimeKind,
      environment:
        input.nodeEnv === "production" ? "production" : "development",
    },
  });
  const directories = resolveAgentObservabilityDirs(
    input.env,
    input.projectId,
    input.deploymentId,
  );
  await writeAgentRuntimePolicy({
    directory: directories.workerDir,
    policy,
  });
  return { policy, ...directories };
}

export function createDeploymentObservabilityReconciler(input: {
  store: Store;
  env: NodeJS.ProcessEnv;
  nodeEnv?: string;
}): () => Promise<number> {
  let appliedRevision: number | undefined;
  let inFlight: Promise<number> | undefined;

  const reconcile = async (): Promise<number> => {
    const policy = await input.store.getObservabilityPolicy(DEFAULT_TEAM_ID);
    if (policy.revision === appliedRevision) return 0;

    let updated = 0;
    for (const project of await input.store.listProjects()) {
      const deployments = await input.store.listDeployments(project.id);
      for (const deployment of deployments) {
        if (
          deployment.status !== "starting" &&
          deployment.status !== "running" &&
          deployment.status !== "draining"
        ) {
          continue;
        }
        await prepareDeploymentObservability({
          store: input.store,
          env: input.env,
          projectId: project.id,
          releaseId: deployment.releaseId,
          deploymentId: deployment.id,
          runtimeKind: deployment.runtimeKind,
          nodeEnv: input.nodeEnv,
          policy,
        });
        updated += 1;
      }
    }
    appliedRevision = policy.revision;
    return updated;
  };

  return () => {
    if (inFlight) return inFlight;
    inFlight = reconcile().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
