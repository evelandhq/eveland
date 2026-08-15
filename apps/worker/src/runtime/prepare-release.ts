import { mkdir } from "node:fs/promises";
import path from "node:path";
import { injectObserverHooks, type ObserverInjectionResult } from "@evelandhq/agent-observer";
import { injectSchedulerAdapter, type SchedulerInjectionResult } from "@evelandhq/agent-scheduler";
import { execa } from "execa";
import { injectExtensionIntegrator } from "./extension-integration.js";
import {
  injectWorkflowWorld,
  type WorkflowWorldBuildConfig,
  type WorkflowWorldInjectionResult,
} from "./workflow-world.js";

export type PreparedReleaseResult = ObserverInjectionResult & {
  extensionIntegratorFile: string;
  workflowWorld?: WorkflowWorldInjectionResult;
  scheduler: SchedulerInjectionResult;
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
  const extensionIntegratorFile = await injectExtensionIntegrator(buildDir);
  return {
    ...observer,
    extensionIntegratorFile,
    ...(workflowWorld ? { workflowWorld } : {}),
    scheduler,
  };
}
