import { execFile } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Store } from "@evelandhq/db";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuthSchema } from "./auth-schema.js";
import { createBetterAuthRuntime } from "./auth.js";

const execFileAsync = promisify(execFile);

/**
 * The Better Auth runtime wired the way identity-routes.test.ts wires it, but
 * exported so out-of-package harnesses (infra/integration/*.mts) can build a
 * control plane with real sign-in without resolving `better-auth` themselves --
 * bare specifiers only resolve from inside apps/api.
 */
export function createControlPlaneAuthRuntime(input: {
  /** A drizzle database over the same PGlite/Postgres the Store uses. */
  db: unknown;
  baseURL: string;
  webOrigin: string;
  secret: string;
}) {
  return createBetterAuthRuntime({
    database: drizzleAdapter(input.db as Parameters<typeof drizzleAdapter>[0], {
      provider: "pg",
      schema: betterAuthSchema,
    }),
    baseURL: input.baseURL,
    webOrigin: input.webOrigin,
    secret: input.secret,
  });
}

/**
 * Records one provider-reported model step the way production does: an
 * observed `usage.recorded` event ingested against a Deployment of the project.
 */
export async function recordObservedModelUsage(
  store: Store,
  input: {
    projectId: string;
    eveSessionId: string;
    agent: { id: string; name: string };
    usage: Record<string, number>;
  },
) {
  const revision = await store.recordSourceRevision({
    projectId: input.projectId,
    kind: "zip",
    sourcePath: "/tmp/usage-fixture",
    summary: {},
    envVars: [],
    files: [],
  });
  const deployment = await store.recordDeployment({
    projectId: input.projectId,
    sourceRevisionId: revision.id,
    imageTag: "fixture:usage",
    observerContract: 3,
    containerName: `fixture-usage-${input.eveSessionId}`,
    internalPort: 3000,
    hostPort: 41994,
    runtimeKind: "docker",
  });
  return store.ingestAgentEvent({
    telemetryEventId: `${input.eveSessionId}_usage`,
    eventFingerprint: `${input.eveSessionId}_usage`,
    deploymentId: deployment.id,
    eveSessionId: input.eveSessionId,
    parentEveSessionId: null,
    sourceSequence: 1,
    agent: { ...input.agent, nodeId: "root" },
    channelKind: "channel:eve",
    eventAt: new Date().toISOString(),
    event: {
      type: "usage.recorded",
      scope: { turnId: "turn_0", runId: "run_0" },
      data: { kind: "model", owner: { runId: "run_0" }, usage: input.usage },
    },
  });
}

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
        definitionHash: "a".repeat(64),
      },
    ],
  });
  const schedule = versions[0]?.schedule;
  if (!schedule) throw new Error("Expected schedule fixture.");
  const deployment = await store.recordDeployment({
    projectId: project.id,
    sourceRevisionId: revision.id,
    imageTag: "fixture:scheduler",
    observerContract: 3,
    containerName: "fixture-scheduler",
    internalPort: 3000,
    hostPort: 41993,
    runtimeKind: "docker",
  });
  await store.setProjectSchedulerTarget(project.id, deployment.id);
  const run = createRun ? await store.createManualScheduleRun(project.id, schedule.id) : null;
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
  await writeFile(path.join(projectDir, "package.json"), JSON.stringify({ name: "zip-agent" }));
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
