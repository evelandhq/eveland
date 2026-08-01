import {
  createAgentRuntimePolicy,
  type AgentRuntimePolicy,
  type ObservabilityPolicy,
} from "@eveland/core/observability";
import {
  createAgentTelemetryCredential,
  deriveAgentTelemetrySecret,
} from "@eveland/core/server/agent-telemetry-credential";
import {
  DEFAULT_TEAM_ID,
  type Store,
} from "@eveland/db";
import {
  bundleObserverRuntime,
  OBSERVER_RUNTIME_CONTRACT,
} from "@eveland/agent-observer";
import type { ReleaseRecord } from "@eveland/core/contracts";
import {
  resolveAgentObservabilityDirs,
  writeAgentObserverRuntime,
  writeAgentRuntimePolicy,
} from "../runtime/observability/policy.js";
import type { RuntimeAdapter } from "../runtime/types.js";

const devSecretKey = "eveland-dev-secret-key-000000000";

/**
 * Surfaces (in the project's runtime log) a release whose baked-in observer
 * predates the delivery contract: its hook shim never loads the
 * Worker-delivered runtime, so its telemetry pipeline is whatever the
 * platform shipped when the release was built -- likely a no-op by now.
 * Called at activation, where a stale release is about to serve sessions.
 */
export async function warnStaleObserverRelease(
  store: Pick<Store, "appendLog">,
  input: {
    projectId: string;
    deploymentId: string;
    release: ReleaseRecord;
  },
): Promise<void> {
  const contract = input.release.observerContract ?? 0;
  if (contract >= OBSERVER_RUNTIME_CONTRACT) return;
  await store.appendLog({
    projectId: input.projectId,
    deploymentId: input.deploymentId,
    type: "runtime",
    line:
      `Release ${input.release.id} embeds an Eveland observer older than this platform ` +
      `(contract ${contract || "unrecorded"} < ${OBSERVER_RUNTIME_CONTRACT}); session transcripts and usage ` +
      `may not be captured. Rebuild the release (redeploy the project) to refresh it.`,
  });
}

export async function prepareDeploymentObservability(input: {
  store: Pick<Store, "getObservabilityPolicy">;
  env: NodeJS.ProcessEnv;
  projectId: string;
  releaseId: string;
  deploymentId: string;
  runtimeKind: RuntimeAdapter["name"];
  nodeEnv?: string;
  policy?: ObservabilityPolicy;
  appSecretKey?: string;
  directories?: { workerDir: string; hostDir: string };
}): Promise<{
  policy: AgentRuntimePolicy;
  workerDir: string;
  hostDir: string;
}> {
  const telemetrySecret = deriveAgentTelemetrySecret(
    input.appSecretKey ?? input.env.APP_SECRET_KEY ?? devSecretKey,
  );
  const policy = createAgentRuntimePolicy({
    policy:
      input.policy ??
      (await input.store.getObservabilityPolicy(DEFAULT_TEAM_ID)),
    otlpEndpoint:
      input.runtimeKind === "docker"
        ? // The Docker adapter connects the Collector to this Deployment's
          // isolated network under a fixed alias.
          "http://eveland-otel-collector:4328"
        : "http://127.0.0.1:4328",
    deploymentCredential: createAgentTelemetryCredential(
      { deploymentId: input.deploymentId, issuedAt: new Date().toISOString() },
      telemetrySecret,
    ),
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
  const directories =
    input.directories ??
    resolveAgentObservabilityDirs(
      input.env,
      input.projectId,
      input.deploymentId,
    );
  await writeAgentRuntimePolicy({
    directory: directories.workerDir,
    policy,
  });
  // Delivered on every prepare so release-baked shims always load an observer
  // that matches this Worker, not the platform version the release was built on.
  await writeAgentObserverRuntime({
    directory: directories.workerDir,
    code: await bundleObserverRuntime(),
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
