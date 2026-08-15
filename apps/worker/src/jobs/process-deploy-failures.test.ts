import { describe, expect, test, vi } from "vitest";
import { createTestStore } from "@evelandhq/db/vitest";
import { processNextJob } from "./process.js";
import { type RuntimeAdapter } from "../runtime/types.js";
import { deriveProjectWorkflowUrl } from "../runtime/workflow-world-bootstrap.js";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encryptSecretValue } from "@evelandhq/core/server/secrets";
import { createFixtureEveProject } from "./process.test-support.js";

describe("processNextJob", () => {
  test("removes a partially prepared build directory when buildRelease fails", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "eveland-failed-build-"));
    vi.stubEnv("EVELAND_DATA_DIR", dataDir);
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Failed Build Cleanup Agent",
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
    let buildDir: string | null = null;

    try {
      await expect(
        processNextJob(store, "worker-a", {
          runtime: {
            name: "systemd",
            async buildRelease(input) {
              buildDir = input.buildDir;
              await mkdir(input.buildDir, { recursive: true });
              await writeFile(path.join(input.buildDir, "partial-artifact"), "partial");
              throw new Error("dependency install failed");
            },
            async startProcess() {
              throw new Error("startProcess must not run");
            },
            async stopProcess() {
              throw new Error("stopProcess must not run");
            },
          },
          allocateHostPort: () => 41098,
        }),
      ).resolves.toBe(true);

      expect(buildDir).not.toBeNull();
      await expect(access(buildDir!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      vi.unstubAllEnvs();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("removes a successful build artifact when startup fails before the deployment is recorded", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "eveland-failed-start-"));
    vi.stubEnv("EVELAND_DATA_DIR", dataDir);
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Failed Start Cleanup Agent",
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
    let buildDir: string | null = null;
    const removedReleases: string[] = [];

    try {
      await expect(
        processNextJob(store, "worker-a", {
          runtime: {
            name: "docker",
            async buildRelease(input) {
              buildDir = input.buildDir;
              await mkdir(input.buildDir, { recursive: true });
              await writeFile(path.join(input.buildDir, "complete-artifact"), "complete");
              return { releaseRef: "failed-start:image", log: "" };
            },
            async startProcess() {
              throw new Error("container failed to start");
            },
            async stopProcess() {
              throw new Error("stopProcess must not run");
            },
            async removeRelease(releaseRef) {
              removedReleases.push(releaseRef);
            },
          },
          allocateHostPort: () => 41097,
        }),
      ).resolves.toBe(true);

      expect(removedReleases).toEqual(["failed-start:image"]);
      expect(buildDir).not.toBeNull();
      await expect(access(buildDir!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      vi.unstubAllEnvs();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("fails a build_deploy job when the deployment port never becomes reachable", async () => {
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Unhealthy Agent",
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

    await expect(
      processNextJob(store, "worker-a", {
        runtime: {
          name: "docker",
          async buildRelease() {
            return { releaseRef: "eveland/proj:rel", log: "" };
          },
          async startProcess() {
            return { internalPort: 3000, log: "" };
          },
          async stopProcess() {},
        },
        allocateHostPort() {
          return 41099;
        },
        async waitForDeployment() {
          throw new Error("port 41099 did not open");
        },
      }),
    ).resolves.toBe(true);

    await expect(store.getProject(project.id)).resolves.toMatchObject({
      status: "failed",
      deploymentStatus: "failed",
      deploymentId: null,
      releaseId: null,
    });
  });

  test("stops the newly started process (not the old deployment) when the health check fails after a successful start", async () => {
    let capturedProcessName: string | null = null;
    const stopCalls: string[] = [];
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "New Process Cleanup Agent",
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
    // An existing deployment so the OLD process's stop (outside the cleanup
    // block) and the NEW process's cleanup stop can be told apart.
    await store.recordDeployment({
      releaseId: "rel_old",
      deploymentId: "dep_old",
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/proj:rel_old",
      containerName: "eveland-old-container",
      internalPort: 3000,
      hostPort: 41110,
      runtimeKind: "docker",
    });
    await store.enqueueJob(project.id, "build_deploy");

    await expect(
      processNextJob(store, "worker-a", {
        runtime: {
          name: "docker",
          async buildRelease() {
            return { releaseRef: "eveland/proj:rel_new", log: "" };
          },
          async startProcess(input) {
            capturedProcessName = input.processName;
            return { internalPort: 3000, log: "" };
          },
          async stopProcess(processName) {
            stopCalls.push(processName);
          },
        },
        allocateHostPort: () => Promise.resolve(41111),
        async waitForDeployment() {
          throw new Error("port never opened");
        },
      }),
    ).resolves.toBe(true);

    expect(capturedProcessName).not.toBeNull();
    expect(stopCalls).toEqual([capturedProcessName]);
    await expect(store.getCurrentDeployment(project.id)).resolves.toMatchObject({ id: "dep_old" });
    await expect(store.getProject(project.id)).resolves.toMatchObject({
      status: "failed",
      deploymentStatus: "running",
    });
  });

  test("captures and masks runtime startup diagnostics before cleaning up an unhealthy deployment", async () => {
    const calls: string[] = [];
    const secretValue = "sk-runtime-diagnostic-secret";
    const appSecretKey = "eveland-test-secret-key-00000000";
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Diagnostic Agent",
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
    await store.upsertSecret(
      project.id,
      "OPENAI_API_KEY",
      JSON.stringify(encryptSecretValue(secretValue, appSecretKey)),
    );
    await store.enqueueJob(project.id, "build_deploy");

    const runtime = {
      name: "docker",
      async buildRelease() {
        return { releaseRef: "eveland/proj:rel_diagnostic", log: "" };
      },
      async startProcess() {
        return { internalPort: 3000, log: "" };
      },
      async getProcessDiagnostics() {
        calls.push("diagnostics");
        return {
          state: "status=restarting restartCount=4 exitCode=1",
          logs: `${"x".repeat(35_000)}\nAgent startup failed while using ${secretValue}`,
        };
      },
      async stopProcess() {
        calls.push("stop");
      },
    } as RuntimeAdapter & {
      getProcessDiagnostics(processName: string): Promise<{ state: string; logs: string }>;
    };

    await expect(
      processNextJob(store, "worker-a", {
        runtime,
        appSecretKey,
        allocateHostPort: () => 41113,
        async waitForDeployment() {
          throw new Error("health check timed out");
        },
      }),
    ).resolves.toBe(true);

    expect(calls).toEqual(["diagnostics", "stop"]);
    const runtimeLogs = await store.listLogs(project.id, "runtime");
    expect(runtimeLogs).toContainEqual(
      expect.objectContaining({
        line: expect.stringMatching(
          /Runtime startup diagnostics.*status=restarting.*Recent logs:.*Agent startup failed/s,
        ),
      }),
    );
    expect(JSON.stringify(runtimeLogs)).not.toContain(secretValue);
    expect(JSON.stringify(runtimeLogs)).toContain("***");
    expect(
      runtimeLogs.find((log) => log.line.includes("Runtime startup diagnostics"))?.line.length,
    ).toBeLessThanOrEqual(32_000);
    expect(JSON.stringify(runtimeLogs)).toContain("runtime diagnostics truncated");
    expect(runtimeLogs.at(-1)?.line).toContain("health check timed out");
  });

  test("does not attempt to stop the new process when startProcess itself fails (nothing was started)", async () => {
    let stopCalled = false;
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Start Fail Agent",
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

    await expect(
      processNextJob(store, "worker-a", {
        runtime: {
          name: "docker",
          async buildRelease() {
            return { releaseRef: "eveland/proj:rel", log: "" };
          },
          async startProcess() {
            throw new Error("failed to start transient unit");
          },
          async stopProcess() {
            stopCalled = true;
          },
        },
        allocateHostPort() {
          return 41111;
        },
        async waitForDeployment() {},
      }),
    ).resolves.toBe(true);

    expect(stopCalled).toBe(false);
    await expect(store.getProject(project.id)).resolves.toMatchObject({
      status: "failed",
      deploymentStatus: "failed",
    });
    await expect(store.listLogs(project.id, "runtime")).resolves.toContainEqual(
      expect.objectContaining({
        line: expect.stringContaining("failed to start transient unit"),
      }),
    );
  });

  test("keeps the original health-check error when diagnostics and cleanup both fail", async () => {
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Double Fail Agent",
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

    await expect(
      processNextJob(store, "worker-a", {
        runtime: {
          name: "docker",
          async buildRelease() {
            return { releaseRef: "eveland/proj:rel", log: "" };
          },
          async startProcess() {
            return { internalPort: 3000, log: "" };
          },
          async getProcessDiagnostics() {
            throw new Error("docker logs unavailable");
          },
          async stopProcess() {
            throw new Error("systemctl stop timed out");
          },
        },
        allocateHostPort() {
          return 41112;
        },
        async waitForDeployment() {
          throw new Error("port 41112 did not open");
        },
      }),
    ).resolves.toBe(true);

    await expect(store.getProject(project.id)).resolves.toMatchObject({
      status: "failed",
      deploymentStatus: "failed",
    });
    // The cleanup failure is logged as its own line, before the generic
    // "Job failed" line -- and the ORIGINAL health error, not the cleanup
    // error, is what the job ultimately fails with.
    await expect(store.listLogs(project.id, "runtime")).resolves.toEqual([
      expect.objectContaining({
        line: "Runtime startup diagnostics (docker) unavailable before cleanup: docker logs unavailable",
      }),
      expect.objectContaining({
        line: "Cleanup after failed deploy also failed: systemctl stop timed out",
      }),
      expect.objectContaining({
        line: expect.stringMatching(/port 41112 did not open/),
      }),
    ]);
    const jobFailedLine = (await store.listLogs(project.id, "runtime"))[2]?.line ?? "";
    expect(jobFailedLine).not.toContain("systemctl stop timed out");
    expect(jobFailedLine).not.toContain("docker logs unavailable");
  });

  test("injects a platform-owned Postgres world and runtime URL even when the agent does not configure either", async () => {
    const runtimeCalls: Array<{ name: string; input: unknown }> = [];
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Durable Agent",
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

    const ensuredProjects: string[] = [];
    await expect(
      processNextJob(store, "worker-a", {
        nodeEnv: "production",
        identityIssuer: "https://control.example.com",
        identityJwksUrl: "http://api:4000/.well-known/jwks.json",
        workflowPostgresUrl: "postgres://eveland:eveland@host.docker.internal:5432/eveland",
        ensureProjectWorkflowWorld: async (env, projectId) => {
          ensuredProjects.push(projectId);
          return deriveProjectWorkflowUrl(env.WORKFLOW_POSTGRES_URL!, projectId);
        },
        runtime: {
          name: "docker",
          async buildRelease(input) {
            runtimeCalls.push({ name: "buildRelease", input });
            return {
              releaseRef: `eveland/${input.projectId.toLowerCase()}:rel`,
              log: "build ok",
            };
          },
          async startProcess(input) {
            runtimeCalls.push({ name: "startProcess", input });
            return { internalPort: 3000, log: "started" };
          },
          async stopProcess() {},
        },
        allocateHostPort() {
          return 41002;
        },
        async waitForDeployment() {},
      }),
    ).resolves.toBe(true);

    const build = runtimeCalls.find((call) => call.name === "buildRelease");
    expect(build?.input).toMatchObject({
      workflowWorld: {
        packageName: "@workflow/world-postgres",
        packageVersion: "5.0.0-beta.34",
      },
    });
    const run = runtimeCalls.find((call) => call.name === "startProcess");
    expect((run!.input as { env: Record<string, string> }).env).toMatchObject({
      WORKFLOW_POSTGRES_URL: deriveProjectWorkflowUrl(
        "postgres://eveland:eveland@host.docker.internal:5432/eveland",
        project.id,
      ),
      NODE_ENV: "production",
      EVELAND_PROJECT_ID: project.id,
      EVELAND_IDENTITY_ISSUER: "https://control.example.com",
      EVELAND_IDENTITY_JWKS_URL: "http://api:4000/.well-known/jwks.json",
    });
    expect(ensuredProjects).toEqual([project.id]);
    await expect(store.getProject(project.id)).resolves.toMatchObject({
      status: "deployed",
    });
  });

  test("keeps the platform workflow database URL reserved when a project defines the same secret", async () => {
    const secretKey = "eveland-test-secret-key-00000000";
    const runtimeCalls: Array<{ name: string; input: unknown }> = [];
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Override Agent",
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
    await store.upsertSecret(
      project.id,
      "WORKFLOW_POSTGRES_URL",
      JSON.stringify(encryptSecretValue("postgres://custom@db:5432/app", secretKey)),
    );
    await store.enqueueJob(project.id, "build_deploy");

    await expect(
      processNextJob(store, "worker-a", {
        appSecretKey: secretKey,
        workflowPostgresUrl: "postgres://platform@host.docker.internal:5432/eveland",
        ensureProjectWorkflowWorld: async (env, projectId) =>
          deriveProjectWorkflowUrl(env.WORKFLOW_POSTGRES_URL!, projectId),
        runtime: {
          name: "docker",
          async buildRelease(input) {
            return {
              releaseRef: `eveland/${input.projectId.toLowerCase()}:rel`,
              log: "build ok",
            };
          },
          async startProcess(input) {
            runtimeCalls.push({ name: "startProcess", input });
            return { internalPort: 3000, log: "started" };
          },
          async stopProcess() {},
        },
        allocateHostPort() {
          return 41003;
        },
        async waitForDeployment() {},
      }),
    ).resolves.toBe(true);

    const run = runtimeCalls.find((call) => call.name === "startProcess");
    expect((run!.input as { env: Record<string, string> }).env.WORKFLOW_POSTGRES_URL).toBe(
      deriveProjectWorkflowUrl("postgres://platform@host.docker.internal:5432/eveland", project.id),
    );
  });

  test("injects the global shared Agent environment as a fallback for Project Secrets", async () => {
    const secretKey = "eveland-test-secret-key-00000000";
    const runtimeCalls: Array<{ name: string; input: unknown }> = [];
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Shared Environment Runtime Agent",
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
    await store.upsertSecret(
      project.id,
      "SHARED_TOKEN",
      JSON.stringify(encryptSecretValue("project-secret-value", secretKey)),
    );
    await store.saveSharedAgentEnvironment({
      entries: [
        {
          key: "SHARED_TOKEN",
          kind: "secret",
          encryptedValue: JSON.stringify(encryptSecretValue("shared-default-value", secretKey)),
        },
        {
          key: "SHARED_ONLY",
          kind: "secret",
          encryptedValue: JSON.stringify(encryptSecretValue("shared-only-value", secretKey)),
        },
      ],
    });
    await store.enqueueJob(project.id, "build_deploy");

    const runtime: RuntimeAdapter = {
      name: "docker",
      async buildRelease(input) {
        runtimeCalls.push({ name: "buildRelease", input });
        return {
          releaseRef: `eveland/${input.projectId.toLowerCase()}:rel`,
          log: "shared-only-value",
        };
      },
      async startProcess(input) {
        runtimeCalls.push({ name: "startProcess", input });
        return { internalPort: 3000, log: "started" };
      },
      async stopProcess() {},
    };
    const options = {
      appSecretKey: secretKey,
      runtime,
      allocateHostPort: () => 41004,
      async waitForDeployment() {},
    };

    await expect(processNextJob(store, "worker-a", options)).resolves.toBe(true);
    const deployment = await store.getCurrentDeployment(project.id);
    expect(deployment).not.toBeNull();
    expect(
      (
        runtimeCalls.find((call) => call.name === "startProcess")!.input as {
          env: Record<string, string>;
        }
      ).env,
    ).toMatchObject({
      SHARED_TOKEN: "project-secret-value",
      SHARED_ONLY: "shared-only-value",
    });
    expect(
      (await store.listLogs(project.id, "build")).map((log) => log.line).join("\n"),
    ).not.toContain("shared-only-value");
  });

  test("gives the build the Agent's variables while keeping every secret out of it", async () => {
    const secretKey = "eveland-test-secret-key-00000000";
    const runtimeCalls: Array<{ name: string; input: unknown }> = [];
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Build Variable Agent",
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
    await store.saveSharedAgentEnvironment({
      entries: [
        {
          key: "MODEL_NAME",
          kind: "variable",
          encryptedValue: JSON.stringify(encryptSecretValue("configured-model", secretKey)),
        },
        {
          key: "OPENAI_API_KEY",
          kind: "secret",
          encryptedValue: JSON.stringify(encryptSecretValue("shared-api-key", secretKey)),
        },
      ],
    });
    await store.upsertSecret(
      project.id,
      "REPORTING_BASE_URL",
      JSON.stringify(encryptSecretValue("https://reporting.example.com", secretKey)),
      "variable",
    );
    await store.enqueueJob(project.id, "build_deploy");

    await expect(
      processNextJob(store, "worker-a", {
        appSecretKey: secretKey,
        runtime: {
          name: "docker",
          async buildRelease(input) {
            runtimeCalls.push({ name: "buildRelease", input });
            return {
              releaseRef: `eveland/${input.projectId.toLowerCase()}:rel`,
              log: "build ok",
            };
          },
          async startProcess(input) {
            runtimeCalls.push({ name: "startProcess", input });
            return { internalPort: 3000, log: "started" };
          },
          async stopProcess() {},
        } satisfies RuntimeAdapter,
        allocateHostPort: () => 41005,
        async waitForDeployment() {},
      }),
    ).resolves.toBe(true);

    const build = runtimeCalls.find((call) => call.name === "buildRelease")!.input as {
      buildVariables: Record<string, string>;
    };
    expect(build.buildVariables).toEqual({
      MODEL_NAME: "configured-model",
      REPORTING_BASE_URL: "https://reporting.example.com",
    });
    expect(
      (
        runtimeCalls.find((call) => call.name === "startProcess")!.input as {
          env: Record<string, string>;
        }
      ).env,
    ).toMatchObject({
      MODEL_NAME: "configured-model",
      OPENAI_API_KEY: "shared-api-key",
    });
  });

  test("blocks a production deploy when the platform durable world has no database URL", async () => {
    let buildCalled = false;
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Local Agent",
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

    await expect(
      processNextJob(store, "worker-a", {
        nodeEnv: "production",
        runtime: {
          name: "docker",
          async buildRelease(input) {
            buildCalled = true;
            return {
              releaseRef: `eveland/${input.projectId.toLowerCase()}:rel`,
              log: "build ok",
            };
          },
          async startProcess() {
            return { internalPort: 3000, log: "started" };
          },
          async stopProcess() {},
        },
        allocateHostPort() {
          return 41004;
        },
        async waitForDeployment() {},
      }),
    ).resolves.toBe(true);

    expect(buildCalled).toBe(false);
    await expect(store.getProject(project.id)).resolves.toMatchObject({
      status: "failed",
      deploymentStatus: "failed",
    });
    await expect(store.listLogs(project.id, "deploy")).resolves.toContainEqual(
      expect.objectContaining({
        line: expect.stringContaining("WORKFLOW_POSTGRES_URL"),
      }),
    );
  });

  test("keeps Eve's local world in development when the platform database URL is absent", async () => {
    let buildCalled = false;
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Dev Local Agent",
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

    await expect(
      processNextJob(store, "worker-a", {
        nodeEnv: "development",
        workflowPostgresUrl: "",
        runtime: {
          name: "docker",
          async buildRelease(input) {
            buildCalled = true;
            return {
              releaseRef: `eveland/${input.projectId.toLowerCase()}:rel`,
              log: "build ok",
            };
          },
          async startProcess() {
            return { internalPort: 3000, log: "started" };
          },
          async stopProcess() {},
        },
        allocateHostPort() {
          return 41005;
        },
        async waitForDeployment() {},
      }),
    ).resolves.toBe(true);

    expect(buildCalled).toBe(true);
    await expect(store.getProject(project.id)).resolves.toMatchObject({
      status: "deployed",
    });
    await expect(store.listLogs(project.id, "deploy")).resolves.not.toContainEqual(
      expect.objectContaining({ line: expect.stringContaining("Warning") }),
    );
  });

  test("fails a deployment before build when the project declares an unsupported Eve version", async () => {
    let buildCalled = false;
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject("0.22.6");
    const project = await store.createProject({
      name: "Old Eve Agent",
      importKind: "zip",
      sourcePath,
    });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath,
      summary: { eveVersion: "0.22.6" },
      envVars: [],
      files: [],
      schedules: [],
    });
    await store.enqueueJob(project.id, "build_deploy");

    await expect(
      processNextJob(store, "worker-a", {
        nodeEnv: "development",
        allocateHostPort: () => 41990,
        waitForDeployment: async () => {},
        runtime: {
          name: "docker",
          async buildRelease() {
            buildCalled = true;
            return { releaseRef: "should-not-build", log: "" };
          },
          async startProcess() {
            return { internalPort: 3000, log: "" };
          },
          async stopProcess() {},
        },
      }),
    ).resolves.toBe(true);

    expect(buildCalled).toBe(false);
    await expect(store.getProject(project.id)).resolves.toMatchObject({
      status: "failed",
      deploymentStatus: "failed",
    });
    await expect(store.listLogs(project.id, "runtime")).resolves.toContainEqual(
      expect.objectContaining({
        line: expect.stringContaining('Unsupported Eve dependency "0.22.6"'),
      }),
    );
  });

  test("deploys in production without requiring the platform world in the agent's package.json", async () => {
    let buildCalled = false;
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Missing Dep Agent",
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

    await expect(
      processNextJob(store, "worker-a", {
        nodeEnv: "production",
        workflowPostgresUrl: "postgres://eveland:eveland@host.docker.internal:5452/eveland",
        ensureProjectWorkflowWorld: async (env, projectId) =>
          deriveProjectWorkflowUrl(env.WORKFLOW_POSTGRES_URL!, projectId),
        runtime: {
          name: "docker",
          async buildRelease(input) {
            buildCalled = true;
            return {
              releaseRef: `eveland/${input.projectId.toLowerCase()}:rel`,
              log: "build ok",
            };
          },
          async startProcess() {
            return { internalPort: 3000, log: "started" };
          },
          async stopProcess() {},
        },
        allocateHostPort() {
          return 41007;
        },
        async waitForDeployment() {},
      }),
    ).resolves.toBe(true);

    expect(buildCalled).toBe(true);
    await expect(store.getProject(project.id)).resolves.toMatchObject({
      status: "deployed",
    });
  });
});
