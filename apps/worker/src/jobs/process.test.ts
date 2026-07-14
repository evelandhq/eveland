import { describe, expect, test } from "vitest";
import { createMemoryStore, type Store } from "@eveland/db";
import {
  allocateAvailableHostPort,
  invalidateGatewayRouteCache,
  processNextJob,
  resolveObserverOutboxDirs,
  resolveSandboxCacheDirs,
} from "./process.js";
import type { RuntimeAdapter } from "../runtime/types.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { encryptSecretValue } from "@eveland/core/server/secrets";
import type { DeploymentRecord } from "@eveland/core/contracts";

describe("processNextJob", () => {
  test("invalidates each materialized Gateway hostname when service credentials are configured", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    await invalidateGatewayRouteCache(
      { EVELAND_GATEWAY_INTERNAL_URL: "http://gateway:4080", EVELAND_GATEWAY_SERVICE_TOKEN: "secret" },
      [{ hostname: "p-one.agent.localhost" }, { hostname: "d-one--p-one.agent.localhost" }],
      async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(null, { status: 200 });
      },
    );
    expect(calls).toEqual([
      expect.objectContaining({ url: "http://gateway:4080/internal/cache/invalidate" }),
      expect.objectContaining({ url: "http://gateway:4080/internal/cache/invalidate" }),
    ]);
    expect(calls.map((call) => call.init?.body)).toEqual([
      JSON.stringify({ hostname: "p-one.agent.localhost" }),
      JSON.stringify({ hostname: "d-one--p-one.agent.localhost" }),
    ]);
  });

  test("maps the worker-visible observer outbox to its Docker-host path", () => {
    expect(
      resolveObserverOutboxDirs(
        { EVELAND_DATA_DIR: "/workspace/.eveland-data", EVELAND_HOST_DATA_DIR: "/host/eveland/.eveland-data" },
        "proj_123",
        "dep_456",
      ),
    ).toEqual({
      workerDir: "/workspace/.eveland-data/observer/proj_123/dep_456",
      hostDir: "/host/eveland/.eveland-data/observer/proj_123/dep_456",
    });
  });

  test("maps the durable sandbox cache to worker-visible and Docker-host paths", () => {
    expect(
      resolveSandboxCacheDirs(
        { EVELAND_DATA_DIR: "/workspace/.eveland-data", EVELAND_HOST_DATA_DIR: "/host/eveland/.eveland-data" },
        "proj_123",
      ),
    ).toEqual({
      workerDir: "/workspace/.eveland-data/sandbox/proj_123",
      hostDir: "/host/eveland/.eveland-data/sandbox/proj_123",
    });
  });

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
      runtimeKind: "docker",
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
          name: "docker",
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
          env: expect.objectContaining({
            OPENAI_API_KEY: "sk-test-123456",
            EVELAND_DEPLOYMENT_ID: expect.stringMatching(/^dep_/),
          }),
          observerOutboxDir: expect.stringContaining(path.join("observer", project.id.toLowerCase())),
        }),
      },
    ]);
    await expect(store.listLogs(project.id, "build")).resolves.toContainEqual(expect.objectContaining({ line: "build ok" }));
    await expect(store.listLogs(project.id, "deploy")).resolves.toContainEqual(expect.objectContaining({ line: "Deployment running on 127.0.0.1:41001." }));
    await expect(store.getCurrentDeployment(project.id)).resolves.toMatchObject({ runtimeKind: "docker" });
  });

  test("deploys a concurrent preview without stopping current or reusing its host port", async () => {
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
      runtimeKind: "docker",
    });
    await store.enqueueJob(project.id, "build_deploy");

    await expect(
      processNextJob(store, "worker-a", {
        runtime: {
          name: "docker",
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
        allocateHostPort: () => Promise.resolve(41078),
        async waitForDeployment() {},
      }),
    ).resolves.toBe(true);

    expect(runtimeCalls).not.toContainEqual({ name: "stopProcess", input: { processName: current.containerName } });
    expect(runtimeCalls).toContainEqual({ name: "startProcess", input: expect.objectContaining({ port: 41078 }) });
    await expect(store.listDeployments(project.id)).resolves.toHaveLength(2);
    await expect(store.getProject(project.id)).resolves.toMatchObject({
      deploymentId: "dep_old",
      releaseId: "rel_old",
    });
    await expect(store.getCurrentDeployment(project.id)).resolves.toMatchObject({ runtimeKind: "docker" });
  });

  test("deploys across runtime kinds without touching the old runtime process", async () => {
    const activeRuntimeCalls: Array<{ name: string; input: unknown }> = [];
    const oldRuntimeStopCalls: Array<{ processName: string }> = [];
    let runtimeForKindCalledWith: "docker" | "systemd" | null = null;
    const store = createMemoryStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({ name: "Cross Kind Agent", importKind: "zip", sourcePath });
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
            return { releaseRef: `eveland/${input.projectId.toLowerCase()}:rel`, log: "" };
          },
          async startProcess(input) {
            activeRuntimeCalls.push({ name: "startProcess", input });
            return { internalPort: 3000, log: "started" };
          },
          async stopProcess(processName) {
            activeRuntimeCalls.push({ name: "stopProcess", input: { processName } });
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
    await expect(store.getCurrentDeployment(project.id)).resolves.toMatchObject({ id: current.id, runtimeKind: "systemd" });
  });

  test("archives only an unprotected artifact outside the recent-three retention window", async () => {
    const store = createMemoryStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({ name: "Retention Worker", importKind: "zip", sourcePath });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({ projectId: project.id, kind: "zip", sourcePath, summary: {}, envVars: [], files: [], schedules: [] });
    const versions: DeploymentRecord[] = [];
    for (let index = 0; index < 4; index += 1) {
      versions.push(await store.recordDeployment({ projectId: project.id, sourceRevisionId: revision.id, imageTag: `image:v${index}`, containerName: `process-v${index}`, internalPort: 3000, hostPort: 41200 + index, runtimeKind: "docker" }));
    }
    await store.ensureDeploymentRoutes(project.id, versions[3]!.id, "agent.localhost");
    await store.promoteDeployment(project.id, versions[3]!.id);
    await store.enqueueJob(project.id, "archive_deployment", { deploymentId: versions[0]!.id });
    const calls: string[] = [];

    await expect(processNextJob(store, "worker-a", { runtime: {
      name: "docker",
      async buildRelease() { throw new Error("not used"); },
      async startProcess() { throw new Error("not used"); },
      async stopProcess(name) { calls.push(`stop:${name}`); },
      async removeRelease(ref) { calls.push(`remove:${ref}`); },
    } })).resolves.toBe(true);

    expect(calls).toEqual(["stop:process-v0", "remove:image:v0"]);
    await expect(store.getDeployment(versions[0]!.id)).resolves.toMatchObject({ status: "archived" });
    await expect(store.getDeployment(versions[1]!.id)).resolves.toMatchObject({ status: "running" });
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
    const store = createMemoryStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({ name: "New Process Cleanup Agent", importKind: "zip", sourcePath });
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
    const oldDeployment = await store.recordDeployment({
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

  test("does not attempt to stop the new process when startProcess itself fails (nothing was started)", async () => {
    let stopCalled = false;
    const store = createMemoryStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({ name: "Start Fail Agent", importKind: "zip", sourcePath });
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
      expect.objectContaining({ line: expect.stringContaining("failed to start transient unit") }),
    );
  });

  test("keeps the original health-check error and separately logs a cleanup stopProcess failure", async () => {
    const store = createMemoryStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({ name: "Double Fail Agent", importKind: "zip", sourcePath });
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
      expect.objectContaining({ line: "Cleanup after failed deploy also failed: systemctl stop timed out" }),
      expect.objectContaining({
        line: expect.stringMatching(/port 41112 did not open/),
      }),
    ]);
    const jobFailedLine = (await store.listLogs(project.id, "runtime"))[1]?.line ?? "";
    expect(jobFailedLine).not.toContain("systemctl stop timed out");
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
          name: "docker",
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
          name: "docker",
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
          name: "docker",
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
          name: "docker",
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
          name: "docker",
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
          name: "docker",
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
          name: "docker",
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

  test("restarts the current deployment by stopping and starting it on the recorded runtime kind", async () => {
    const secretKey = "eveland-test-secret-key-00000000";
    const runtimeCalls: Array<{ name: string; input: unknown }> = [];
    const store = createMemoryStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({ name: "Restart Agent", importKind: "zip", sourcePath });
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
      JSON.stringify(encryptSecretValue("sk-test-restart", secretKey)),
    );
    const deployment = await store.recordDeployment({
      releaseId: "rel_cur",
      deploymentId: "dep_cur",
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/proj:rel_cur",
      containerName: "eveland-cur-container",
      internalPort: 3000,
      hostPort: 41050,
      runtimeKind: "docker",
    });
    await store.enqueueJob(project.id, "restart_deployment");

    await expect(
      processNextJob(store, "worker-a", {
        appSecretKey: secretKey,
        workflowPostgresUrl: "postgres://platform@host.docker.internal:5432/eveland",
        runtime: {
          name: "docker",
          async buildRelease() {
            throw new Error("restart must never build a release");
          },
          async startProcess(input) {
            runtimeCalls.push({ name: "startProcess", input });
            return { internalPort: 3000, log: "started" };
          },
          async stopProcess(processName) {
            runtimeCalls.push({ name: "stopProcess", input: { processName } });
          },
        },
        async waitForDeployment() {},
      }),
    ).resolves.toBe(true);

    expect(runtimeCalls).toEqual([
      { name: "stopProcess", input: { processName: deployment.containerName } },
      {
        name: "startProcess",
        input: expect.objectContaining({
          processName: deployment.containerName,
          releaseRef: "eveland/proj:rel_cur",
          port: deployment.hostPort,
          env: expect.objectContaining({
            WORKFLOW_POSTGRES_URL: "postgres://platform@host.docker.internal:5432/eveland",
            OPENAI_API_KEY: "sk-test-restart",
            EVELAND_DEPLOYMENT_ID: deployment.id,
          }),
          observerOutboxDir: expect.stringContaining(path.join("observer", project.id.toLowerCase(), deployment.id)),
        }),
      },
    ]);
    await expect(store.getProject(project.id)).resolves.toMatchObject({ deploymentStatus: "running" });
    await expect(store.listLogs(project.id, "deploy")).resolves.toEqual([
      expect.objectContaining({ line: "Restart requested." }),
      expect.objectContaining({ line: `Deployment running on 127.0.0.1:${deployment.hostPort}.` }),
    ]);
  });

  test("resolves the runtime adapter by the deployment's recorded runtimeKind when no runtime override is injected", async () => {
    const runtimeCalls: Array<{ name: string; input: unknown }> = [];
    let runtimeForKindCalledWith: "docker" | "systemd" | null = null;
    const store = createMemoryStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({ name: "Restart Systemd Agent", importKind: "zip", sourcePath });
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
    const deployment = await store.recordDeployment({
      releaseId: "rel_systemd",
      deploymentId: "dep_systemd",
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/proj:rel_systemd",
      containerName: "eveland-systemd-unit",
      internalPort: 3000,
      hostPort: 41051,
      runtimeKind: "systemd",
    });
    await store.enqueueJob(project.id, "restart_deployment");

    // The deployment was made by systemd; only the systemd adapter may stop and
    // restart its unit, regardless of what runtime kind the worker defaults to.
    const systemdAdapter: RuntimeAdapter = {
      name: "systemd",
      async buildRelease() {
        throw new Error("restart must never build a release");
      },
      async startProcess(input) {
        runtimeCalls.push({ name: "startProcess", input });
        return { internalPort: 3000, log: "started" };
      },
      async stopProcess(processName) {
        runtimeCalls.push({ name: "stopProcess", input: { processName } });
      },
    };

    await expect(
      processNextJob(store, "worker-a", {
        runtimeForKind(kind) {
          runtimeForKindCalledWith = kind;
          return systemdAdapter;
        },
        async waitForDeployment() {},
      }),
    ).resolves.toBe(true);

    expect(runtimeForKindCalledWith).toBe("systemd");
    expect(runtimeCalls).toEqual([
      { name: "stopProcess", input: { processName: deployment.containerName } },
      expect.objectContaining({ name: "startProcess" }),
    ]);
    await expect(store.getProject(project.id)).resolves.toMatchObject({ deploymentStatus: "running" });
  });

  test("stops the restarted process when its health check fails after restart's own stop and start succeed", async () => {
    const stopCalls: string[] = [];
    const store = createMemoryStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({ name: "Restart Cleanup Agent", importKind: "zip", sourcePath });
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
    const deployment = await store.recordDeployment({
      releaseId: "rel_restart_fail",
      deploymentId: "dep_restart_fail",
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/proj:rel_restart_fail",
      containerName: "eveland-restart-fail-container",
      internalPort: 3000,
      hostPort: 41113,
      runtimeKind: "docker",
    });
    await store.enqueueJob(project.id, "restart_deployment");

    await expect(
      processNextJob(store, "worker-a", {
        runtime: {
          name: "docker",
          async buildRelease() {
            throw new Error("restart must never build a release");
          },
          async startProcess() {
            return { internalPort: 3000, log: "" };
          },
          async stopProcess(processName) {
            stopCalls.push(processName);
          },
        },
        async waitForDeployment() {
          throw new Error("restarted process never became healthy");
        },
      }),
    ).resolves.toBe(true);

    // Once for the restart's own stop of the running deployment, once more
    // for cleanup of the freshly restarted (but unhealthy) replacement.
    expect(stopCalls).toEqual([deployment.containerName, deployment.containerName]);
    await expect(store.getProject(project.id)).resolves.toMatchObject({
      status: "failed",
      deploymentStatus: "failed",
    });
    await expect(store.listLogs(project.id, "runtime")).resolves.toContainEqual(
      expect.objectContaining({ line: expect.stringContaining("restarted process never became healthy") }),
    );
  });

  test("stops the pre-restart process exactly once when startProcess itself fails during restart (nothing new was started)", async () => {
    const stopCalls: string[] = [];
    const store = createMemoryStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({ name: "Restart Start Fail Agent", importKind: "zip", sourcePath });
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
    const deployment = await store.recordDeployment({
      releaseId: "rel_restart_start_fail",
      deploymentId: "dep_restart_start_fail",
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/proj:rel_restart_start_fail",
      containerName: "eveland-restart-start-fail-container",
      internalPort: 3000,
      hostPort: 41114,
      runtimeKind: "docker",
    });
    await store.enqueueJob(project.id, "restart_deployment");

    await expect(
      processNextJob(store, "worker-a", {
        runtime: {
          name: "docker",
          async buildRelease() {
            throw new Error("restart must never build a release");
          },
          async startProcess() {
            throw new Error("failed to start transient unit");
          },
          async stopProcess(processName) {
            stopCalls.push(processName);
          },
        },
      }),
    ).resolves.toBe(true);

    // Only the pre-restart stop ran: `restarted` stays false when startProcess
    // itself throws, so there is nothing new to clean up and the cleanup stop
    // must not fire a second time.
    expect(stopCalls).toEqual([deployment.containerName]);
    await expect(store.getProject(project.id)).resolves.toMatchObject({
      status: "failed",
      deploymentStatus: "failed",
    });
    await expect(store.listLogs(project.id, "runtime")).resolves.toContainEqual(
      expect.objectContaining({ line: expect.stringContaining("failed to start transient unit") }),
    );
  });

  test("fails a restart_deployment job when there is no deployment to restart", async () => {
    const store = createMemoryStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({ name: "No Deployment Agent", importKind: "zip", sourcePath });
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
    await store.enqueueJob(project.id, "restart_deployment");

    await expect(processNextJob(store, "worker-a")).resolves.toBe(true);

    await expect(store.getProject(project.id)).resolves.toMatchObject({ status: "failed", deploymentStatus: "failed" });
    await expect(store.listLogs(project.id, "runtime")).resolves.toContainEqual(
      expect.objectContaining({ line: expect.stringContaining("No deployment to restart.") }),
    );
  });

  test("fails a restart_deployment job when the deployment's release record is missing", async () => {
    const store = createMemoryStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({ name: "Corrupt State Agent", importKind: "zip", sourcePath });
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
    await store.recordDeployment({
      releaseId: "rel_missing",
      deploymentId: "dep_missing",
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/proj:rel_missing",
      containerName: "eveland-missing-container",
      internalPort: 3000,
      hostPort: 41052,
      runtimeKind: "docker",
    });
    await store.enqueueJob(project.id, "restart_deployment");
    // Simulates corrupt state: the deployment's release row is gone even though
    // the deployment itself still is (a deployment without its release is not
    // recoverable, so restart must fail loudly rather than guess).
    const storeWithMissingRelease: Store = {
      ...store,
      async getRelease() {
        return null;
      },
    };

    await expect(processNextJob(storeWithMissingRelease, "worker-a")).resolves.toBe(true);

    await expect(store.getProject(project.id)).resolves.toMatchObject({ status: "failed", deploymentStatus: "failed" });
    await expect(store.listLogs(project.id, "runtime")).resolves.toContainEqual(
      expect.objectContaining({ line: expect.stringContaining("rel_missing") }),
    );
  });

  test("fails a restart_deployment job loudly when the revision's source directory has vanished from disk, without stopping the running process first", async () => {
    const store = createMemoryStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({ name: "Vanished Source Agent", importKind: "zip", sourcePath });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    // A real temp dir, then removed -- the revision's sourcePath row still
    // points at it, but nothing exists there anymore on disk.
    const vanishedSourcePath = await mkdtemp(path.join(os.tmpdir(), "eveland-vanished-"));
    await rm(vanishedSourcePath, { recursive: true, force: true });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: vanishedSourcePath,
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    await store.recordDeployment({
      releaseId: "rel_vanished",
      deploymentId: "dep_vanished",
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/proj:rel_vanished",
      containerName: "eveland-vanished-container",
      internalPort: 3000,
      hostPort: 41060,
      runtimeKind: "docker",
    });
    await store.enqueueJob(project.id, "restart_deployment");

    const stopCalls: string[] = [];
    await expect(
      processNextJob(store, "worker-a", {
        runtime: {
          name: "docker",
          async buildRelease() {
            throw new Error("restart must never build a release");
          },
          async startProcess() {
            throw new Error("restart must never start a process when the source dir is missing");
          },
          async stopProcess(processName) {
            stopCalls.push(processName);
          },
        },
      }),
    ).resolves.toBe(true);

    // The missing-source check must run before the pre-restart stop, so a
    // vanished source dir never takes the currently running process down.
    expect(stopCalls).toEqual([]);
    await expect(store.getProject(project.id)).resolves.toMatchObject({ status: "failed", deploymentStatus: "failed" });
    await expect(store.listLogs(project.id, "runtime")).resolves.toContainEqual(
      expect.objectContaining({
        line: expect.stringContaining(
          `Source directory for revision ${revision.id} is missing: ${vanishedSourcePath}. Re-import the source and deploy instead.`,
        ),
      }),
    );
  });

  test("delete_project stops the deployment through its recorded runtimeKind adapter, logging before stopping, then deletes the project last", async () => {
    const calls: string[] = [];
    const store = createMemoryStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({ name: "Delete Agent", importKind: "zip", sourcePath });
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
    const deployment = await store.recordDeployment({
      releaseId: "rel_del",
      deploymentId: "dep_del",
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/proj:rel_del",
      containerName: "eveland-del-systemd-unit",
      internalPort: 3000,
      hostPort: 41060,
      runtimeKind: "systemd",
    });
    await store.enqueueJob(project.id, "delete_project");

    let runtimeForKindCalledWith: "docker" | "systemd" | null = null;
    // Only the systemd adapter may stop a systemd unit; the worker's active
    // default runtime (docker, injected as `options.runtime` in other tests)
    // must never be consulted for stopping a deployment it doesn't own.
    const stopAdapter: RuntimeAdapter = {
      name: "systemd",
      async buildRelease() {
        throw new Error("delete_project must never build a release");
      },
      async startProcess() {
        throw new Error("delete_project must never start a process");
      },
      async stopProcess(processName) {
        calls.push(`stopProcess:${processName}`);
      },
    };
    const spyingStore: Store = {
      ...store,
      async appendLog(input) {
        calls.push(`appendLog:${input.line}`);
        return store.appendLog(input);
      },
      async updateProjectState(projectId, state) {
        calls.push("updateProjectState");
        return store.updateProjectState(projectId, state);
      },
      async deleteProject(projectId) {
        calls.push(`deleteProject:${projectId}`);
        return store.deleteProject(projectId);
      },
    };

    await expect(
      processNextJob(spyingStore, "worker-a", {
        runtimeForKind(kind) {
          runtimeForKindCalledWith = kind;
          return stopAdapter;
        },
      }),
    ).resolves.toBe(true);

    expect(runtimeForKindCalledWith).toBe("systemd");
    // The log must land before the process is stopped, and nothing --
    // no log, no state update -- may follow the delete.
    expect(calls).toEqual([
      "appendLog:Stopping 1 deployment(s) before deleting project.",
      `stopProcess:${deployment.containerName}`,
      `deleteProject:${project.id}`,
    ]);
    await expect(store.getProject(project.id)).resolves.toBeNull();
  });

  test("delete_project with no current deployment deletes the project without stopping or logging anything", async () => {
    const calls: string[] = [];
    const store = createMemoryStore();
    const project = await store.createProject({ name: "No Deployment Delete Agent", importKind: "zip", sourcePath: "/tmp/no-deployment" });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    await store.enqueueJob(project.id, "delete_project");

    const spyingStore: Store = {
      ...store,
      async appendLog(input) {
        calls.push(`appendLog:${input.line}`);
        return store.appendLog(input);
      },
      async deleteProject(projectId) {
        calls.push(`deleteProject:${projectId}`);
        return store.deleteProject(projectId);
      },
    };

    await expect(processNextJob(spyingStore, "worker-a")).resolves.toBe(true);

    expect(calls).toEqual([`deleteProject:${project.id}`]);
    await expect(store.getProject(project.id)).resolves.toBeNull();
  });

  test("delete_project is idempotent: a re-run against an already-gone project returns silently", async () => {
    const calls: string[] = [];
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Already Gone Agent", importKind: "zip", sourcePath: "/tmp/already-gone" });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    await store.enqueueJob(project.id, "delete_project");

    // Simulates a half-finished delete_project retry: the project row is
    // already gone (e.g. a prior run got as far as store.deleteProject before
    // crashing), but nothing else about the store is touched.
    const storeWithProjectGone: Store = {
      ...store,
      async getProject(projectId) {
        calls.push(`getProject:${projectId}`);
        return null;
      },
      async getCurrentDeployment(projectId) {
        calls.push(`getCurrentDeployment:${projectId}`);
        return store.getCurrentDeployment(projectId);
      },
      async deleteProject(projectId) {
        calls.push(`deleteProject:${projectId}`);
        return store.deleteProject(projectId);
      },
    };

    await expect(processNextJob(storeWithProjectGone, "worker-a")).resolves.toBe(true);

    // The handler must return immediately after the missing getProject check --
    // it must never call getCurrentDeployment or deleteProject again.
    expect(calls).toEqual([`getProject:${project.id}`]);
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
