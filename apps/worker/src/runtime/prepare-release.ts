import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { injectObserverHooks, type ObserverInjectionResult } from "@evelandhq/agent-observer";
import { injectSchedulerAdapter, type SchedulerInjectionResult } from "@evelandhq/agent-scheduler";
import {
  injectModelGatewayRuntime,
  type ModelGatewayInjectionResult,
} from "@evelandhq/model-gateway-runtime/inject";
import { execa } from "execa";
import { injectExtensionIntegrator } from "./extension-integration.js";
import {
  injectWorkflowWorld,
  type WorkflowWorldBuildConfig,
  type WorkflowWorldInjectionResult,
} from "./workflow-world.js";

export type PreparedReleaseResult = ObserverInjectionResult & {
  extensionIntegratorFile?: string;
  workflowWorld?: WorkflowWorldInjectionResult;
  scheduler: SchedulerInjectionResult;
  modelGateway: ModelGatewayInjectionResult;
};

export async function prepareReleaseTree(input: {
  sourcePath: string;
  buildDir: string;
  workflowWorld?: WorkflowWorldBuildConfig;
}): Promise<PreparedReleaseResult> {
  const sourcePath = path.resolve(input.sourcePath);
  const buildDir = path.resolve(input.buildDir);
  if (sourcePath === buildDir)
    throw new Error("Prepared release directory must be distinct from the imported source tree.");

  await mkdir(buildDir, { recursive: true });
  await execa("cp", ["-a", `${sourcePath}/.`, buildDir]);
  const observer = await injectObserverHooks({ releaseDir: buildDir });
  const workflowWorld = input.workflowWorld
    ? await injectWorkflowWorld({ releaseDir: buildDir, config: input.workflowWorld })
    : undefined;
  const scheduler = await injectSchedulerAdapter({ releaseDir: buildDir });
  const modelGateway = await injectModelGatewayRuntime({ releaseDir: buildDir });
  const extensionIntegratorFile = (await hasExtensionMountSources(buildDir))
    ? await injectExtensionIntegrator(buildDir)
    : undefined;
  return {
    ...observer,
    ...(extensionIntegratorFile ? { extensionIntegratorFile } : {}),
    ...(workflowWorld ? { workflowWorld } : {}),
    scheduler,
    modelGateway,
  };
}

async function hasExtensionMountSources(releaseDir: string): Promise<boolean> {
  const nestedAgentRoot = path.join(releaseDir, "agent");
  const agentRoot = (await isDirectory(nestedAgentRoot)) ? nestedAgentRoot : releaseDir;
  return agentTreeHasExtensions(agentRoot);
}

async function agentTreeHasExtensions(agentRoot: string): Promise<boolean> {
  const extensionEntries = await readdir(path.join(agentRoot, "extensions"), {
    withFileTypes: true,
  }).catch(() => []);
  if (extensionEntries.length > 0) return true;

  const subagents = await readdir(path.join(agentRoot, "subagents"), {
    withFileTypes: true,
  }).catch(() => []);
  for (const subagent of subagents) {
    if (
      subagent.isDirectory() &&
      (await agentTreeHasExtensions(path.join(agentRoot, "subagents", subagent.name)))
    ) {
      return true;
    }
  }
  return false;
}

async function isDirectory(target: string): Promise<boolean> {
  return readdir(target).then(
    () => true,
    () => false,
  );
}
