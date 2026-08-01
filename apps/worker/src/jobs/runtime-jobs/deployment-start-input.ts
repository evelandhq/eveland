import type {
  ProcessStartInput,
  RuntimeAdapter,
  RuntimeCommandContext,
} from "../../runtime/types.js";

type AdapterVisibleDirectories = {
  workerDir: string;
  hostDir: string;
};

export type DeploymentStartInput = {
  processName: string;
  releaseRef: string;
  port: number;
  deploymentId: string;
  env: Record<string, string>;
  commandContext: RuntimeCommandContext;
  runtimeKind: RuntimeAdapter["name"];
  sandboxCacheDirs: AdapterVisibleDirectories;
  observabilityPolicyDirs: AdapterVisibleDirectories;
};

export function createDeploymentStartInput(
  input: DeploymentStartInput,
): ProcessStartInput {
  const usesHostVisiblePaths = input.runtimeKind === "docker";
  return {
    processName: input.processName,
    releaseRef: input.releaseRef,
    port: input.port,
    env: { ...input.env, EVELAND_DEPLOYMENT_ID: input.deploymentId },
    commandContext: input.commandContext,
    sandboxCacheDir: usesHostVisiblePaths
      ? input.sandboxCacheDirs.hostDir
      : input.sandboxCacheDirs.workerDir,
    observabilityPolicyDir: usesHostVisiblePaths
      ? input.observabilityPolicyDirs.hostDir
      : input.observabilityPolicyDirs.workerDir,
  };
}
