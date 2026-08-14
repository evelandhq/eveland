import { describe, expect, test, vi } from "vitest";
import { createTestStore } from "@evelandhq/db/vitest";
import { JobLeaseLostError, processNextJob } from "./process.js";
import { dispatchJob } from "./job-registry.js";
import { type RuntimeAdapter } from "../runtime/types.js";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encryptSecretValue } from "@evelandhq/core/server/secrets";
import type { DeploymentRecord } from "@evelandhq/core/contracts";
import { createFixtureEveProject } from "./process.test-support.js";
import { execa } from "execa";

describe("processNextJob", () => {
  test("a fenced import attempt creates no source revision", async () => {
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Fenced Import Agent",
      importKind: "zip",
      sourcePath,
    });
    const job = await store.claimNextJob("worker-old");
    const controller = new AbortController();
    const leaseLost = new JobLeaseLostError();
    controller.abort(leaseLost);

    await expect(dispatchJob(store, job!, { signal: controller.signal })).rejects.toBe(leaseLost);
    await expect(store.getCurrentSourceRevision(project.id)).resolves.toBeNull();
    await expect(store.listLogs(project.id, "build")).resolves.toEqual([]);
  });

  test("isolates Git source directories by claim attempt", async () => {
    const store = createTestStore();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "eveland-attempt-import-"));
    const gitSource = await createFixtureEveProject();
    await execa("git", ["init", "--initial-branch=main"], { cwd: gitSource });
    await execa("git", ["config", "user.email", "worker@example.test"], {
      cwd: gitSource,
    });
    await execa("git", ["config", "user.name", "Worker Test"], {
      cwd: gitSource,
    });
    await execa("git", ["add", "."], { cwd: gitSource });
    await execa("git", ["commit", "-m", "fixture"], { cwd: gitSource });
    const project = await store.createProject({
      name: "Attempt-isolated Import Agent",
      importKind: "git",
      gitUrl: gitSource,
    });
    const job = await store.claimNextJob("worker-attempt");
    const previousDataDir = process.env.EVELAND_DATA_DIR;
    process.env.EVELAND_DATA_DIR = dataDir;

    try {
      await dispatchJob(store, job!, {});

      await expect(store.getCurrentSourceRevision(project.id)).resolves.toMatchObject({
        sourcePath: path.join(dataDir, "sources", project.id, job!.id, `attempt-${job!.attempts}`),
      });
    } finally {
      if (previousDataDir === undefined) delete process.env.EVELAND_DATA_DIR;
      else process.env.EVELAND_DATA_DIR = previousDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("processes import_source jobs into imported project state", async () => {
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Import Agent",
      importKind: "zip",
      sourcePath,
    });

    await expect(processNextJob(store, "worker-a")).resolves.toBe(true);
    await expect(store.getProject(project.id)).resolves.toMatchObject({
      status: "imported",
      sourceRevisionId: expect.stringMatching(/^src_/),
    });
    await expect(store.getCurrentSourceRevision(project.id)).resolves.toMatchObject({
      summary: { eveVersion: "0.34.5" },
    });
    await expect(store.getSourceFile(project.id, "agent/instructions.md")).resolves.toMatchObject({
      content: "You are concise.",
    });
    await expect(store.listLogs(project.id, "build")).resolves.toEqual([
      expect.objectContaining({
        line: "Source import completed for import-agent.",
      }),
    ]);
    // Without a deploy flag the import must not chain a build_deploy job.
    await expect(store.claimNextJob("worker-idle")).resolves.toBeNull();
  });

  test("saves a pending user Git credential only after a source import succeeds", async () => {
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Private GitLab Agent",
      importKind: "git",
      gitUrl: "https://gitlab.example.com/group/agent.git",
    });
    const initialImport = await store.claimNextJob("fixture-import");
    await store.completeJob(initialImport!.id);
    await store.enqueueJob(project.id, "import_source", {
      importKind: "git",
      sourcePath,
      gitCredential: {
        userId: "user_one",
        host: "gitlab.example.com",
        encryptedToken: "encrypted-token",
        persistAfterImport: true,
      },
    });

    await expect(store.getGitCredential("user_one", "gitlab.example.com")).resolves.toBeNull();
    await expect(processNextJob(store, "worker-a")).resolves.toBe(true);
    await expect(store.getGitCredential("user_one", "gitlab.example.com")).resolves.toMatchObject({
      encryptedToken: "encrypted-token",
    });
    await expect(
      store.listProjectJobs(project.id, { type: "import_source", limit: 1 }),
    ).resolves.toEqual([
      expect.objectContaining({
        payload: expect.not.objectContaining({
          gitCredential: expect.anything(),
        }),
      }),
    ]);
  });

  test("removes a pending Git credential from a failed import job without saving it", async () => {
    const store = createTestStore();
    const invalidSourcePath = await mkdtemp(path.join(os.tmpdir(), "eveland-invalid-git-import-"));
    const project = await store.createProject({
      name: "Failed Private GitLab Agent",
      importKind: "git",
      gitUrl: "https://gitlab.example.com/group/agent.git",
    });
    const initialImport = await store.claimNextJob("fixture-import");
    await store.completeJob(initialImport!.id);
    await store.enqueueJob(project.id, "import_source", {
      importKind: "git",
      sourcePath: invalidSourcePath,
      gitCredential: {
        userId: "user_one",
        host: "gitlab.example.com",
        encryptedToken: "encrypted-token",
        persistAfterImport: true,
      },
    });

    await expect(processNextJob(store, "worker-a")).resolves.toBe(true);
    await expect(store.getGitCredential("user_one", "gitlab.example.com")).resolves.toBeNull();
    await expect(
      store.listProjectJobs(project.id, { type: "import_source", limit: 1 }),
    ).resolves.toEqual([
      expect.objectContaining({
        status: "failed",
        payload: expect.not.objectContaining({
          gitCredential: expect.anything(),
        }),
      }),
    ]);
  });

  test("completes a job with its claimed attempt token", async () => {
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    await store.createProject({
      name: "Fenced Completion Agent",
      importKind: "zip",
      sourcePath,
    });
    const completeJob = vi.spyOn(store, "completeJob");

    await processNextJob(store, "worker-a");

    expect(completeJob).toHaveBeenCalledWith(expect.any(String), 1);
  });

  test("chains promotion intent into the build_deploy job", async () => {
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "CD Agent",
      importKind: "zip",
      sourcePath,
    });
    const initialImport = await store.claimNextJob("worker-a");
    await store.completeJob(initialImport!.id);
    await store.enqueueJob(project.id, "import_source", {
      importKind: "zip",
      sourcePath,
      deployAfterImport: true,
      promoteAfterDeploy: true,
    });

    await expect(processNextJob(store, "worker-a")).resolves.toBe(true);

    const chained = await store.claimNextJob("worker-b");
    expect(chained).toMatchObject({
      type: "build_deploy",
      status: "running",
      payload: { promoteAfterDeploy: true },
    });
    await expect(store.listLogs(project.id, "build")).resolves.toContainEqual(
      expect.objectContaining({
        line: expect.stringContaining("Queued deploy of the latest source"),
      }),
    );
  });

  test("a failed re-sync import leaves an already-running deployment's status untouched", async () => {
    const store = createTestStore();
    const badSource = await mkdtemp(path.join(os.tmpdir(), "eveland-empty-"));
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Live Agent",
      importKind: "git",
      gitUrl: "https://example.com/agent.git",
    });
    const initialImport = await store.claimNextJob("worker-a");
    await store.completeJob(initialImport!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "git",
      sourcePath,
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/live:rel_1",
      containerName: "eveland-live",
      internalPort: 3000,
      hostPort: 41010,
      runtimeKind: "docker",
    });
    // A re-sync whose source fails to scan (here, an empty directory) must not
    // knock the running deployment into a failed state.
    await store.enqueueJob(project.id, "import_source", {
      importKind: "git",
      sourcePath: badSource,
    });

    await expect(processNextJob(store, "worker-a")).resolves.toBe(true);

    await expect(store.getProject(project.id)).resolves.toMatchObject({
      status: "failed",
      deploymentStatus: "running",
    });
  });

  test("returns false when no queued job exists", async () => {
    const store = createTestStore();

    await expect(processNextJob(store, "worker-a")).resolves.toBe(false);
  });

  test("builds and runs the current source revision as a deployment", async () => {
    const secretKey = "eveland-test-secret-key-00000000";
    const runtimeCalls: Array<{ name: string; input: unknown }> = [];
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Deploy Agent",
      importKind: "zip",
      sourcePath,
    });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath,
      summary: {},
      envVars: ["OPENAI_API_KEY"],
      files: [],
      schedules: [],
    });
    await store.upsertSecret(
      project.id,
      "OPENAI_API_KEY",
      JSON.stringify(encryptSecretValue("sk-test-123456", secretKey)),
    );
    await store.enqueueJob(project.id, "build_deploy");

    await expect(
      processNextJob(store, "worker-a", {
        appSecretKey: secretKey,
        workflowPostgresUrl: "",
        runtime: {
          name: "docker",
          async buildRelease(input) {
            runtimeCalls.push({
              name: "buildRelease",
              input: {
                sourcePath: input.sourcePath,
                projectId: input.projectId,
              },
            });
            return {
              releaseRef: `eveland/${input.projectId.toLowerCase()}:rel`,
              log: "build ok",
              schedulerDefinitions: [
                {
                  key: "daily",
                  kind: "markdown" as const,
                  cron: "0 8 * * *",
                  sourcePath: "agent/schedules/daily.md",
                  definitionHash: "daily-v1",
                  modulePath: "agent/schedules/daily.ts",
                },
              ],
              discovery: {
                manifest: {
                  kind: "eve-agent-discovery-manifest",
                  version: 12,
                  agentId: "fixture-agent",
                  agentRoot: `${input.sourcePath}/agent`,
                  appRoot: input.sourcePath,
                  instructions: [{ logicalPath: "instructions.md" }],
                  tools: [],
                  skills: [],
                  subagents: [],
                  connections: [],
                  schedules: [{ logicalPath: "schedules/daily.md" }],
                  hooks: [],
                  channels: [],
                  sandbox: null,
                  diagnosticsSummary: { errors: 0, warnings: 0 },
                },
                resolvedEveVersion: "0.34.5",
              },
            };
          },
          async startProcess(input) {
            runtimeCalls.push({ name: "startProcess", input });
            return { internalPort: 3000, log: "started" };
          },
          async stopProcess(processName) {
            runtimeCalls.push({ name: "stopProcess", input: { processName } });
          },
        },
        allocateHostPort() {
          return 41001;
        },
        async waitForDeployment() {},
      }),
    ).resolves.toBe(true);

    await expect(store.getProject(project.id)).resolves.toMatchObject({
      status: "deployed",
      deploymentStatus: "running",
      sourceRevisionId: revision.id,
      releaseId: expect.stringMatching(/^rel_/),
      deploymentId: expect.stringMatching(/^dep_/),
    });
    expect(runtimeCalls).toEqual([
      {
        name: "buildRelease",
        input: {
          sourcePath,
          projectId: project.id,
        },
      },
      {
        name: "startProcess",
        input: expect.objectContaining({
          processName: expect.stringMatching(
            new RegExp(`^eveland-${project.id.toLowerCase()}-dep_`),
          ),
          releaseRef: `eveland/${project.id.toLowerCase()}:rel`,
          port: 41001,
          env: expect.objectContaining({
            OPENAI_API_KEY: "sk-test-123456",
            EVELAND_DEPLOYMENT_ID: expect.stringMatching(/^dep_/),
          }),
        }),
      },
    ]);
    await expect(store.listLogs(project.id, "build")).resolves.toContainEqual(
      expect.objectContaining({ line: "build ok" }),
    );
    // The built release's eve discovery manifest is recorded on the release --
    // never on the shared source revision, which stays the import-time preview.
    const recordedDeployment = await store.getCurrentDeployment(project.id);
    await expect(store.getRelease(recordedDeployment!.releaseId)).resolves.toMatchObject({
      summary: expect.objectContaining({
        summarySource: "build-manifest",
        manifestVersion: 12,
        agentId: "fixture-agent",
        layout: "nested",
        eveVersionResolved: "0.34.5",
        instructions: ["agent/instructions.md"],
        schedules: ["agent/schedules/daily.md"],
        diagnostics: { errors: 0, warnings: 0 },
      }),
    });
    await expect(store.getSourceRevision(revision.id)).resolves.toMatchObject({
      summary: {},
    });
    await expect(store.listLogs(project.id, "build")).resolves.toContainEqual(
      expect.objectContaining({
        line: expect.stringContaining("Recorded the release summary from eve's discovery manifest"),
      }),
    );
    await expect(store.listLogs(project.id, "deploy")).resolves.toContainEqual(
      expect.objectContaining({
        line: "Deployment running on 127.0.0.1:41001.",
      }),
    );
    await expect(store.getCurrentDeployment(project.id)).resolves.toMatchObject({
      runtimeKind: "docker",
    });
    await expect(store.listProjectScheduleVersions(project.id, revision.id)).resolves.toEqual([
      expect.objectContaining({
        schedule: expect.objectContaining({ key: "daily" }),
        version: expect.objectContaining({
          kind: "markdown",
          cron: "0 8 * * *",
          definitionHash: "daily-v1",
        }),
      }),
    ]);
  });

  test("selects pnpm when the imported source has a pnpm lockfile", async () => {
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    await writeFile(path.join(sourcePath, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const project = await store.createProject({
      name: "Pnpm Agent",
      importKind: "zip",
      sourcePath,
    });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath,
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    await store.enqueueJob(project.id, "build_deploy");

    let buildCommandContext: unknown;
    let startCommandContext: unknown;
    await expect(
      processNextJob(store, "worker-a", {
        workflowPostgresUrl: "",
        runtime: {
          name: "docker",
          async buildRelease(input) {
            buildCommandContext = input.commandContext;
            return { releaseRef: "eveland/pnpm:rel", log: "build ok" };
          },
          async startProcess(input) {
            startCommandContext = input.commandContext;
            return { internalPort: 3000, log: "started" };
          },
          async stopProcess() {},
        },
        allocateHostPort() {
          return 41071;
        },
        async waitForDeployment() {},
      }),
    ).resolves.toBe(true);

    expect(buildCommandContext).toEqual({
      packageManager: "pnpm",
      hasLockfile: true,
    });
    expect(startCommandContext).toBe(buildCommandContext);
  });

  test("deploys a concurrent preview without stopping current or reusing its host port", async () => {
    const runtimeCalls: Array<{ name: string; input: unknown }> = [];
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Redeploy Agent",
      importKind: "zip",
      sourcePath,
    });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath,
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const current = await store.recordDeployment({
      releaseId: "rel_old",
      deploymentId: "dep_old",
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/proj:rel_old",
      containerName: "eveland-old-container",
      internalPort: 3000,
      hostPort: 41077,
      runtimeKind: "docker",
    });
    await store.enqueueJob(project.id, "build_deploy");

    await expect(
      processNextJob(store, "worker-a", {
        runtime: {
          name: "docker",
          async buildRelease(input) {
            runtimeCalls.push({
              name: "buildRelease",
              input: {
                sourcePath: input.sourcePath,
                projectId: input.projectId,
              },
            });
            return {
              releaseRef: `eveland/${input.projectId.toLowerCase()}:rel`,
              log: "",
            };
          },
          async startProcess(input) {
            runtimeCalls.push({ name: "startProcess", input });
            return { internalPort: 3000, log: "started" };
          },
          async stopProcess(processName) {
            runtimeCalls.push({ name: "stopProcess", input: { processName } });
          },
        },
        allocateHostPort: () => Promise.resolve(41078),
        async waitForDeployment() {},
      }),
    ).resolves.toBe(true);

    expect(runtimeCalls).not.toContainEqual({
      name: "stopProcess",
      input: { processName: current.containerName },
    });
    expect(runtimeCalls).toContainEqual({
      name: "startProcess",
      input: expect.objectContaining({ port: 41078 }),
    });
    await expect(store.listDeployments(project.id)).resolves.toHaveLength(2);
    await expect(store.getProject(project.id)).resolves.toMatchObject({
      deploymentId: "dep_old",
      releaseId: "rel_old",
    });
    await expect(store.getCurrentDeployment(project.id)).resolves.toMatchObject({
      runtimeKind: "docker",
    });
  });

  test("promotes the exact deployment created by a promote-enabled build", async () => {
    const stoppedProcesses: string[] = [];
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Promoted Sync Agent",
      importKind: "git",
      gitUrl: "https://example.com/promoted.git",
    });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "git",
      sourcePath,
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const production = await store.recordDeployment({
      releaseId: "rel_production",
      deploymentId: "dep_production",
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/proj:rel_production",
      containerName: "eveland-production-container",
      internalPort: 3000,
      hostPort: 41080,
      runtimeKind: "docker",
    });
    await store.ensureDeploymentRoutes(project.id, production.id, "agent.localhost");
    await store.enqueueJob(project.id, "build_deploy", {
      promoteAfterDeploy: true,
    });

    await expect(
      processNextJob(store, "worker-a", {
        runtime: {
          name: "docker",
          async buildRelease() {
            return { releaseRef: "eveland/proj:rel_promoted", log: "" };
          },
          async startProcess() {
            return { internalPort: 3000, log: "started" };
          },
          async stopProcess(processName) {
            stoppedProcesses.push(processName);
          },
        },
        allocateHostPort: () => Promise.resolve(41081),
        async waitForDeployment() {},
      }),
    ).resolves.toBe(true);

    const deployments = await store.listDeployments(project.id);
    const promoted = deployments.find((deployment) => deployment.id !== production.id);
    expect(promoted).toBeDefined();
    await expect(store.findProjectRoute(project.id)).resolves.toMatchObject({
      targets: [
        expect.objectContaining({
          deploymentId: promoted!.id,
          weight: 10_000,
        }),
      ],
    });
    await expect(store.getCurrentDeployment(project.id)).resolves.toMatchObject({
      id: promoted!.id,
    });
    expect(stoppedProcesses).not.toContain(production.containerName);
  });

  test("deploys across runtime kinds without touching the old runtime process", async () => {
    const activeRuntimeCalls: Array<{ name: string; input: unknown }> = [];
    const oldRuntimeStopCalls: Array<{ processName: string }> = [];
    let runtimeForKindCalledWith: "docker" | "systemd" | null = null;
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Cross Kind Agent",
      importKind: "zip",
      sourcePath,
    });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath,
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    // The current deployment was made by systemd; the worker's active runtime
    // below is docker. Only the systemd adapter may stop the systemd unit.
    const current = await store.recordDeployment({
      releaseId: "rel_old",
      deploymentId: "dep_old",
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/proj:rel_old",
      containerName: "eveland-old-systemd-unit",
      internalPort: 3000,
      hostPort: 41078,
      runtimeKind: "systemd",
    });
    await store.enqueueJob(project.id, "build_deploy");

    const oldKindAdapter: RuntimeAdapter = {
      name: "systemd",
      async buildRelease() {
        throw new Error("the old deployment's adapter must never be asked to build");
      },
      async startProcess() {
        throw new Error("the old deployment's adapter must never be asked to start");
      },
      async stopProcess(processName) {
        oldRuntimeStopCalls.push({ processName });
      },
    };

    await expect(
      processNextJob(store, "worker-a", {
        runtime: {
          name: "docker",
          async buildRelease(input) {
            return {
              releaseRef: `eveland/${input.projectId.toLowerCase()}:rel`,
              log: "",
            };
          },
          async startProcess(input) {
            activeRuntimeCalls.push({ name: "startProcess", input });
            return { internalPort: 3000, log: "started" };
          },
          async stopProcess(processName) {
            activeRuntimeCalls.push({
              name: "stopProcess",
              input: { processName },
            });
          },
        },
        runtimeForKind(kind) {
          runtimeForKindCalledWith = kind;
          return oldKindAdapter;
        },
        allocateHostPort: () => Promise.resolve(41079),
        async waitForDeployment() {},
      }),
    ).resolves.toBe(true);

    expect(runtimeForKindCalledWith).toBeNull();
    expect(oldRuntimeStopCalls).toEqual([]);
    expect(activeRuntimeCalls.some((call) => call.name === "stopProcess")).toBe(false);
    await expect(store.getCurrentDeployment(project.id)).resolves.toMatchObject({
      id: current.id,
      runtimeKind: "systemd",
    });
  });

  test("archives only an unprotected artifact outside the recent-three retention window and removes its build directory", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "eveland-archive-build-"));
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Retention Worker",
      importKind: "zip",
      sourcePath,
    });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath,
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const versions: DeploymentRecord[] = [];
    for (let index = 0; index < 4; index += 1) {
      versions.push(
        await store.recordDeployment({
          projectId: project.id,
          sourceRevisionId: revision.id,
          imageTag: `image:v${index}`,
          containerName: `process-v${index}`,
          internalPort: 3000,
          hostPort: 41200 + index,
          runtimeKind: "docker",
        }),
      );
    }
    await store.ensureDeploymentRoutes(project.id, versions[3]!.id, "agent.localhost");
    await store.promoteDeployment(project.id, versions[3]!.id);
    await store.enqueueJob(project.id, "archive_deployment", {
      deploymentId: versions[0]!.id,
    });
    const buildDir = path.join(dataDir, "builds", project.id, versions[0]!.releaseId);
    await mkdir(buildDir, { recursive: true });
    await writeFile(path.join(buildDir, "artifact"), "release");
    const calls: string[] = [];

    try {
      await expect(
        processNextJob(store, "worker-a", {
          dataDir,
          runtime: {
            name: "docker",
            async buildRelease() {
              throw new Error("not used");
            },
            async startProcess() {
              throw new Error("not used");
            },
            async stopProcess(name) {
              calls.push(`stop:${name}`);
            },
            async removeRelease(ref) {
              calls.push(`remove:${ref}`);
            },
          },
        }),
      ).resolves.toBe(true);

      expect(calls).toEqual(["stop:process-v0", "remove:image:v0"]);
      await expect(access(buildDir)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(store.getDeployment(versions[0]!.id)).resolves.toMatchObject({
        status: "archived",
      });
      await expect(store.getDeployment(versions[1]!.id)).resolves.toMatchObject({
        status: "running",
      });
      await expect(store.listLogs(project.id, "deploy")).resolves.toContainEqual(
        expect.objectContaining({
          line: `Deployment ${versions[0]!.deploymentKey} archived.`,
        }),
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("does not automatically archive a deployment that became running after the sweep", async () => {
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Retention Race Worker",
      importKind: "zip",
      sourcePath,
    });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath,
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const versions: DeploymentRecord[] = [];
    for (let index = 0; index < 4; index += 1) {
      versions.push(
        await store.recordDeployment({
          projectId: project.id,
          sourceRevisionId: revision.id,
          imageTag: `retention-race:v${index}`,
          containerName: `retention-race-v${index}`,
          internalPort: 3000,
          hostPort: 41220 + index,
          runtimeKind: "systemd",
        }),
      );
    }
    await store.ensureDeploymentRoutes(project.id, versions[3]!.id, "agent.localhost");
    await store.updateDeploymentStatus(versions[0]!.id, "stopped");
    await store.enqueueJob(project.id, "archive_deployment", {
      deploymentId: versions[0]!.id,
      automatic: true,
    });
    await store.updateDeploymentStatus(versions[0]!.id, "running");
    const calls: string[] = [];

    await expect(
      processNextJob(store, "worker-a", {
        runtime: {
          name: "systemd",
          async buildRelease() {
            throw new Error("not used");
          },
          async startProcess() {
            throw new Error("not used");
          },
          async stopProcess(name) {
            calls.push(`stop:${name}`);
          },
          async removeRelease(ref) {
            calls.push(`remove:${ref}`);
          },
        },
      }),
    ).resolves.toBe(true);

    expect(calls).toEqual([]);
    await expect(store.getDeployment(versions[0]!.id)).resolves.toMatchObject({
      status: "running",
    });
  });
});
