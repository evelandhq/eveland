import { mkdir } from "node:fs/promises";
import path from "node:path";
import { injectObserverHooks, type ObserverInjectionResult } from "@eveland/agent-observer";
import { execa } from "execa";

export async function prepareReleaseTree(input: { sourcePath: string; buildDir: string }): Promise<ObserverInjectionResult> {
  const sourcePath = path.resolve(input.sourcePath);
  const buildDir = path.resolve(input.buildDir);
  if (sourcePath === buildDir) throw new Error("Prepared release directory must be distinct from the imported source tree.");

  await mkdir(buildDir, { recursive: true });
  await execa("cp", ["-a", `${sourcePath}/.`, buildDir]);
  return injectObserverHooks({ releaseDir: buildDir });
}
