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
        runtime: {
          async buildImage(contextDir, imageTag) {
            runtimeCalls.push({ name: "buildImage", input: { contextDir, imageTag } });
            return "build ok";
          },
          async stopContainer(containerName) {
            runtimeCalls.push({ name: "stopContainer", input: { containerName } });
          },
          async runContainer(input) {
            runtimeCalls.push({ name: "runContainer", input });
            return "container-id";
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
        name: "buildImage",
        input: {
          contextDir: sourcePath,
          imageTag: expect.stringMatching(new RegExp(`^eveland/${project.id.toLowerCase()}:rel_`)),
        },
      },
      {
        name: "runContainer",
        input: expect.objectContaining({
          containerName: expect.stringMatching(new RegExp(`^eveland-${project.id.toLowerCase()}-dep_`)),
          hostPort: 41001,
          internalPort: 3000,
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
          async buildImage(contextDir, imageTag) {
            runtimeCalls.push({ name: "buildImage", input: { contextDir, imageTag } });
            return "";
          },
          async stopContainer(containerName) {
            runtimeCalls.push({ name: "stopContainer", input: { containerName } });
          },
          async runContainer(input) {
            runtimeCalls.push({ name: "runContainer", input });
            return "container-id";
          },
        },
        allocateHostPort() {
          throw new Error("existing deployments should keep their port");
        },
        async waitForDeployment() {},
      }),
    ).resolves.toBe(true);

    expect(runtimeCalls).toContainEqual({ name: "stopContainer", input: { containerName: current.containerName } });
    expect(runtimeCalls).toContainEqual({ name: "runContainer", input: expect.objectContaining({ hostPort: current.hostPort }) });
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
          async buildImage() {
            return "";
          },
          async stopContainer() {},
          async runContainer() {
            return "container-id";
          },
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
});

async function createFixtureEveProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "eveland-eve-"));
  await mkdir(path.join(root, "agent", "schedules"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture-agent" }));
  await writeFile(path.join(root, "agent", "instructions.md"), "You are concise.");
  await writeFile(path.join(root, "agent", "schedules", "daily.md"), "---\ncron: \"0 8 * * *\"\n---\nReport.");
  return root;
}
