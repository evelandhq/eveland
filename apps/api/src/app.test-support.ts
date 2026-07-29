import { execFile } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Store } from "@eveland/db";

const execFileAsync = promisify(execFile);

export async function createScheduleRunFixture(store: Store, createRun = true) {
  const project = await store.createProject({
    name: "Scheduled Agent",
    importKind: "zip",
  });
  const importJob = await store.claimNextJob("fixture-import");
  await store.completeJob(importJob!.id);
  const revision = await store.recordSourceRevision({
    projectId: project.id,
    kind: "zip",
    sourcePath: "/tmp/scheduled-agent",
    summary: {},
    envVars: [],
    files: [],
    schedules: [],
  });
  const versions = await store.recordScheduleVersions({
    projectId: project.id,
    sourceRevisionId: revision.id,
    definitions: [
      {
        key: "billing/sweep",
        kind: "handler",
        cron: "0 3 * * *",
        sourcePath: "agent/schedules/billing/sweep.ts",
        definitionHash: "fixture-v1",
      },
    ],
  });
  const schedule = versions[0]?.schedule;
  if (!schedule) throw new Error("Expected schedule fixture.");
  const deployment = await store.recordDeployment({
    projectId: project.id,
    sourceRevisionId: revision.id,
    imageTag: "fixture:scheduler",
    containerName: "fixture-scheduler",
    internalPort: 3000,
    hostPort: 41993,
    runtimeKind: "docker",
  });
  await store.setProjectSchedulerTarget(project.id, deployment.id);
  const run = createRun
    ? await store.createManualScheduleRun(project.id, schedule.id)
    : null;
  return { project, schedule, deployment, run: run! };
}

export async function createZipArchiveFixture(
  options: { wrappedDirectory?: string } = {},
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "eveland-zip-source-"));
  const sourceDir = path.join(root, "source");
  const projectDir = options.wrappedDirectory
    ? path.join(sourceDir, options.wrappedDirectory)
    : sourceDir;
  await mkdir(path.join(projectDir, "agent"), { recursive: true });
  await writeFile(
    path.join(projectDir, "package.json"),
    JSON.stringify({ name: "zip-agent" }),
  );
  await writeFile(
    path.join(projectDir, "agent", "instructions.md"),
    "You are a helpful test agent.",
  );
  const archivePath = path.join(root, "agent.zip");
  await execFileAsync("zip", ["-qr", archivePath, "."], { cwd: sourceDir });
  return archivePath;
}

/**
 * A zip whose entry NAMES are all safe but which contains a symlink pointing
 * outside the extraction dir, followed by a file path THROUGH the link --
 * the archive shape name-only validation cannot catch.
 */
export async function createSymlinkZipArchiveFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "eveland-zip-symlink-"));
  const sourceDir = path.join(root, "source");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(path.join(sourceDir, "package.json"), JSON.stringify({ name: "evil-agent" }));
  await symlink("/tmp", path.join(sourceDir, "escape"));
  const archivePath = path.join(root, "evil.zip");
  // -y stores the symlink as a symlink instead of resolving it.
  await execFileAsync("zip", ["-qry", archivePath, "."], { cwd: sourceDir });
  return archivePath;
}
