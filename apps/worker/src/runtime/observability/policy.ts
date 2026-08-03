import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { OBSERVER_RUNTIME_FILE_NAME } from "@eveland/agent-observer";
import {
  AGENT_RUNTIME_POLICY_PATH,
  agentRuntimePolicySchema,
  type AgentRuntimePolicy,
} from "@eveland/core/observability";
import { processSafeName } from "../types.js";

export const AGENT_OBSERVABILITY_MOUNT_DIR = path.posix.dirname(AGENT_RUNTIME_POLICY_PATH);
const policyFileName = path.posix.basename(AGENT_RUNTIME_POLICY_PATH);
export const AGENT_OBSERVABILITY_POLICY_FILE_NAME = policyFileName;

export async function writeAgentRuntimePolicy(input: {
  directory: string;
  policy: AgentRuntimePolicy;
}): Promise<string> {
  const policy = agentRuntimePolicySchema.parse(input.policy);
  const directory = path.resolve(input.directory);
  const policyPath = path.join(directory, policyFileName);
  const temporaryPath = path.join(directory, `.${policyFileName}.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true, mode: 0o2750 });
  await chmod(directory, 0o2750);

  const handle = await open(temporaryPath, "wx", 0o640);
  try {
    await handle.writeFile(`${JSON.stringify(policy)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporaryPath, { force: true });
    throw error;
  }
  await handle.close();
  await rename(temporaryPath, policyPath);
  return policyPath;
}

/**
 * Atomically places the current observer runtime bundle next to the policy
 * file, where the deployment's read-only observability mount exposes it at
 * PLATFORM_OBSERVER_RUNTIME_PATH. Release-baked shims import it from there,
 * so the observer stays current without rebuilding the release.
 */
export async function writeAgentObserverRuntime(input: {
  directory: string;
  code: string;
}): Promise<string> {
  const directory = path.resolve(input.directory);
  const runtimePath = path.join(directory, OBSERVER_RUNTIME_FILE_NAME);
  const temporaryPath = path.join(directory, `.${OBSERVER_RUNTIME_FILE_NAME}.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true, mode: 0o2750 });
  await chmod(directory, 0o2750);

  const handle = await open(temporaryPath, "wx", 0o640);
  try {
    await handle.writeFile(input.code, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporaryPath, { force: true });
    throw error;
  }
  await handle.close();
  await rename(temporaryPath, runtimePath);
  return runtimePath;
}

export function resolveAgentObservabilityDirs(
  env: NodeJS.ProcessEnv,
  projectId: string,
  deploymentId: string,
): { workerDir: string; hostDir: string } {
  const dataDir = path.resolve(env.EVELAND_DATA_DIR ?? ".eveland-data");
  const hostDataDir = path.resolve(env.EVELAND_HOST_DATA_DIR ?? dataDir);
  const suffix = path.join(
    "observability",
    processSafeName(projectId),
    processSafeName(deploymentId),
  );
  return {
    workerDir: path.join(dataDir, suffix),
    hostDir: path.join(hostDataDir, suffix),
  };
}
