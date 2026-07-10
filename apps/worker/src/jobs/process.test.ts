import { describe, expect, test } from "vitest";
import { createMemoryStore } from "@eveland/api/store";
import { allocateAvailableHostPort, processNextJob } from "./process.js";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { encryptSecretValue } from "@eveland/shared/secrets";

describe("processNextJob", () => {
  test("allocates a later host port when the preferred port is already listening", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address === "string" || !address) {
      throw new Error("Expected TCP address.");
    }

    try {
      const port = await allocateAvailableHostPort(address.port, address.port + 10);
      expect(port).toBeGreaterThan(address.port);
      expect(port).toBeLessThanOrEqual(address.port + 10);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  test("processes import_source jobs into imported project state", async () => {
    const store = createMemoryStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({ name: "Import Agent", importKind: "zip", sourcePath });

    await expect(processNextJob(store, "worker-a")).resolves.toBe(true);
    await expect(store.getProject(project.id)).resolves.toMatchObject({ status: "imported", sourceRevisionId: expect.stringMatching(/^src_/) });
    await expect(store.getSourceFile(project.id, "agent/instructions.md")).resolves.toMatchObject({ content: "You are concise." });
    await expect(store.listLogs(project.id, "build")).resolves.toEqual([
      expect.objectContaining({ line: "Source import completed for Import Agent." }),
    ]);
    // Without a deploy flag the import must not chain a build_deploy job.
    await expect(store.claimNextJob("worker-idle")).resolves.toBeNull();
  });

  test("chains a build_deploy job after a deploy-flagged import", async () => {
    const store = createMemoryStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({ name: "CD Agent", importKind: "zip", sourcePath });
    const initialImport = await store.claimNextJob("worker-a");
    await store.completeJob(initialImport!.id);
    await store.enqueueJob(project.id, "import_source", { importKind: "zip", sourcePath, deployAfterImport: true });

    await expect(processNextJob(store, "worker-a")).resolves.toBe(true);

    const chained = await store.claimNextJob("worker-b");
    expect(chained).toMatchObject({ type: "build_deploy", status: "running" });
    await expect(store.listLogs(project.id, "build")).resolves.toContainEqual(
      expect.objectContaining({ line: expect.stringContaining("Queued deploy of the latest source") }),
    );
  });

  test("a failed re-sync import leaves an already-running deployment's status untouched", async () => {
    const store = createMemoryStore();
    const badSource = await mkdtemp(path.join(os.tmpdir(), "eveland-empty-"));
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({ name: "Live Agent", importKind: "git", gitUrl: "https://example.com/agent.git" });
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
    });
    // A re-sync whose source fails to scan (here, an empty directory) must not
    // knock the running deployment into a failed state.
    await store.enqueueJob(project.id, "import_source", { importKind: "git", sourcePath: badSource });

    await expect(processNextJob(store, "worker-a")).resolves.toBe(true);

    await expect(store.getProject(project.id)).resolves.toMatchObject({ status: "failed", deploymentStatus: "running" });
  });

  test("returns false when no queued job exists", async () => {
    const store = createMemoryStore();

    await expect(processNextJob(store, "worker-a")).resolves.toBe(false);
  });

  test("builds and runs the current source revision as a deployment", async () => {
    const secretKey = "eveland-test-secret-key-00000000";
    const runtimeCalls: Array<{ name: string; input: unknown }> = [];
    const store = createMemoryStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({ name: "Deploy Agent", importKind: "zip", sourcePath });
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
    await store.upsertSecret(project.id, "OPENAI_API_KEY", JSON.stringify(encryptSecretValue("sk-test-123456", secretKey)));
    await store.enqueueJob(project.id, "build_deploy");

    await expect(
      processNextJob(store, "worker-a", {
        appSecretKey: secretKey,
        workflowPostgresUrl: "",
        runtime: {
          name: "fake",
          async buildRelease(input) {
            runtimeCalls.push({ name: "buildRelease", input: { sourcePath: input.sourcePath, projectId: input.projectId } });
            return { releaseRef: `eveland/${input.projectId.toLowerCase()}:rel`, log: "build ok" };
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
          processName: expect.stringMatching(new RegExp(`^eveland-${project.id.toLowerCase()}-dep_`)),
          releaseRef: `eveland/${project.id.toLowerCase()}:rel`,
          port: 41001,
          env: { OPENAI_API_KEY: "sk-test-123456" },
        }),
      },
    ]);
    await expect(store.listLogs(project.id, "build")).resolves.toContainEqual(expect.objectContaining({ line: "build ok" }));
    await expect(store.listLogs(project.id, "deploy")).resolves.toContainEqual(expect.objectContaining({ line: "Deployment running on 127.0.0.1:41001." }));
  });

  test("redeploys by stopping the current deployment and reusing its host port", async () => {
    const runtimeCalls: Array<{ name: string; input: unknown }> = [];
    const store = createMemoryStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({ name: "Redeploy Agent", importKind: "zip", sourcePath });
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
    });
    await store.enqueueJob(project.id, "build_deploy");

    await expect(
      processNextJob(store, "worker-a", {
        runtime: {
          name: "fake",
          async buildRelease(input) {
            runtimeCalls.push({ name: "buildRelease", input: { sourcePath: input.sourcePath, projectId: input.projectId } });
            return { releaseRef: `eveland/${input.projectId.toLowerCase()}:rel`, log: "" };
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
          throw new Error("existing deployments should keep their port");
        },
        async waitForDeployment() {},
      }),
    ).resolves.toBe(true);

    expect(runtimeCalls).toContainEqual({ name: "stopProcess", input: { processName: current.containerName } });
    expect(runtimeCalls).toContainEqual({ name: "startProcess", input: expect.objectContaining({ port: current.hostPort }) });
    await expect(store.getProject(project.id)).resolves.toMatchObject({
      deploymentId: expect.not.stringMatching(/^dep_old$/),
      releaseId: expect.not.stringMatching(/^rel_old$/),
    });
  });

  test("fails a build_deploy job when the deployment port never becomes reachable", async () => {
    const store = createMemoryStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({ name: "Unhealthy Agent", importKind: "zip", sourcePath });
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
          name: "fake",
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

  test("injects WORKFLOW_POSTGRES_URL and NODE_ENV for a durable world in production", async () => {
    const runtimeCalls: Array<{ name: string; input: unknown }> = [];
    const store = createMemoryStore();
    const sourcePath = await createFixtureEveProject({ dependencies: { "@workflow/world-postgres": "5.0.0-beta.20" } });
    const project = await store.createProject({ name: "Durable Agent", importKind: "zip", sourcePath });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath,
      summary: { workflowWorld: "@workflow/world-postgres" },
      envVars: [],
      files: [],
      schedules: [],
    });
    await store.enqueueJob(project.id, "build_deploy");

    await expect(
      processNextJob(store, "worker-a", {
        nodeEnv: "production",
        workflowPostgresUrl: "postgres://eveland:eveland@host.docker.internal:5432/eveland",
        runtime: {
          name: "fake",
          async buildRelease(input) {
            return { releaseRef: `eveland/${input.projectId.toLowerCase()}:rel`, log: "build ok" };
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

    const run = runtimeCalls.find((call) => call.name === "startProcess");
    expect((run?.input as { env: Record<string, string> }).env).toMatchObject({
      WORKFLOW_POSTGRES_URL: "postgres://eveland:eveland@host.docker.internal:5432/eveland",
      NODE_ENV: "production",
    });
    await expect(store.getProject(project.id)).resolves.toMatchObject({ status: "deployed" });
  });

  test("lets a project secret override the injected WORKFLOW_POSTGRES_URL", async () => {
    const secretKey = "eveland-test-secret-key-00000000";
    const runtimeCalls: Array<{ name: string; input: unknown }> = [];
    const store = createMemoryStore();
    const sourcePath = await createFixtureEveProject({ dependencies: { "@workflow/world-postgres": "5.0.0-beta.20" } });
    const project = await store.createProject({ name: "Override Agent", importKind: "zip", sourcePath });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath,
      summary: { workflowWorld: "@workflow/world-postgres" },
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
        runtime: {
          name: "fake",
          async buildRelease(input) {
            return { releaseRef: `eveland/${input.projectId.toLowerCase()}:rel`, log: "build ok" };
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
    expect((run?.input as { env: Record<string, string> }).env.WORKFLOW_POSTGRES_URL).toBe(
      "postgres://custom@db:5432/app",
    );
  });

  test("blocks the deploy in production when no durable world is configured", async () => {
    let buildCalled = false;
    const store = createMemoryStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({ name: "Local Agent", importKind: "zip", sourcePath });
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
          name: "fake",
          async buildRelease(input) {
            buildCalled = true;
            return { releaseRef: `eveland/${input.projectId.toLowerCase()}:rel`, log: "build ok" };
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
    await expect(store.getProject(project.id)).resolves.toMatchObject({ status: "failed", deploymentStatus: "failed" });
    await expect(store.listLogs(project.id, "deploy")).resolves.toContainEqual(
      expect.objectContaining({ line: expect.stringContaining("Deploy blocked") }),
    );
  });

  test("warns but still deploys in development when no durable world is configured", async () => {
    let buildCalled = false;
    const store = createMemoryStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({ name: "Dev Local Agent", importKind: "zip", sourcePath });
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
          name: "fake",
          async buildRelease(input) {
            buildCalled = true;
            return { releaseRef: `eveland/${input.projectId.toLowerCase()}:rel`, log: "build ok" };
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
    await expect(store.getProject(project.id)).resolves.toMatchObject({ status: "deployed" });
    await expect(store.listLogs(project.id, "deploy")).resolves.toContainEqual(
      expect.objectContaining({ line: expect.stringContaining("Warning") }),
    );
  });

  test("blocks the deploy in production when the durable world has no platform URL", async () => {
    let buildCalled = false;
    const store = createMemoryStore();
    const sourcePath = await createFixtureEveProject({ dependencies: { "@workflow/world-postgres": "5.0.0-beta.20" } });
    const project = await store.createProject({ name: "No URL Agent", importKind: "zip", sourcePath });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath,
      summary: { workflowWorld: "@workflow/world-postgres" },
      envVars: [],
      files: [],
      schedules: [],
    });
    await store.enqueueJob(project.id, "build_deploy");

    await expect(
      processNextJob(store, "worker-a", {
        nodeEnv: "production",
        workflowPostgresUrl: "",
        runtime: {
          name: "fake",
          async buildRelease(input) {
            buildCalled = true;
            return { releaseRef: `eveland/${input.projectId.toLowerCase()}:rel`, log: "build ok" };
          },
          async startProcess() {
            return { internalPort: 3000, log: "started" };
          },
          async stopProcess() {},
        },
        allocateHostPort() {
          return 41006;
        },
        async waitForDeployment() {},
      }),
    ).resolves.toBe(true);

    expect(buildCalled).toBe(false);
    await expect(store.getProject(project.id)).resolves.toMatchObject({ status: "failed" });
  });

  test("blocks the deploy in production when the durable world package is not a dependency", async () => {
    let buildCalled = false;
    const store = createMemoryStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({ name: "Missing Dep Agent", importKind: "zip", sourcePath });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath,
      summary: { workflowWorld: "@workflow/world-postgres" },
      envVars: [],
      files: [],
      schedules: [],
    });
    await store.enqueueJob(project.id, "build_deploy");

    await expect(
      processNextJob(store, "worker-a", {
        nodeEnv: "production",
        workflowPostgresUrl: "postgres://eveland:eveland@host.docker.internal:5452/eveland",
        runtime: {
          name: "fake",
          async buildRelease(input) {
            buildCalled = true;
            return { releaseRef: `eveland/${input.projectId.toLowerCase()}:rel`, log: "build ok" };
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

    expect(buildCalled).toBe(false);
    await expect(store.getProject(project.id)).resolves.toMatchObject({ status: "failed" });
    await expect(store.listLogs(project.id, "deploy")).resolves.toContainEqual(
      expect.objectContaining({ line: expect.stringContaining("not in package.json") }),
    );
  });

  test("deploys in production when the durable world package is an optional dependency", async () => {
    let buildCalled = false;
    const store = createMemoryStore();
    const sourcePath = await createFixtureEveProject({
      optionalDependencies: { "@workflow/world-postgres": "5.0.0-beta.20" },
    });
    const project = await store.createProject({ name: "Optional Dep Agent", importKind: "zip", sourcePath });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath,
      summary: { workflowWorld: "@workflow/world-postgres" },
      envVars: [],
      files: [],
      schedules: [],
    });
    await store.enqueueJob(project.id, "build_deploy");

    await expect(
      processNextJob(store, "worker-a", {
        nodeEnv: "production",
        workflowPostgresUrl: "postgres://eveland:eveland@host.docker.internal:5452/eveland",
        runtime: {
          name: "fake",
          async buildRelease(input) {
            buildCalled = true;
            return { releaseRef: `eveland/${input.projectId.toLowerCase()}:rel`, log: "build ok" };
          },
          async startProcess() {
            return { internalPort: 3000, log: "started" };
          },
          async stopProcess() {},
        },
        allocateHostPort() {
          return 41008;
        },
        async waitForDeployment() {},
      }),
    ).resolves.toBe(true);

    expect(buildCalled).toBe(true);
    await expect(store.getProject(project.id)).resolves.toMatchObject({ status: "deployed" });
  });
});

async function createFixtureEveProject(
  options: { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> } = {},
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "eveland-eve-"));
  await mkdir(path.join(root, "agent", "schedules"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "fixture-agent",
      dependencies: options.dependencies ?? {},
      ...(options.optionalDependencies ? { optionalDependencies: options.optionalDependencies } : {}),
    }),
  );
  await writeFile(path.join(root, "agent", "instructions.md"), "You are concise.");
  await writeFile(path.join(root, "agent", "schedules", "daily.md"), "---\ncron: \"0 8 * * *\"\n---\nReport.");
  return root;
}
