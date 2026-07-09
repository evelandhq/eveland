import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { createMemoryStore } from "./store.js";

const execFileAsync = promisify(execFile);

describe("api app", () => {
  test("returns health status", async () => {
    const app = createApp(createMemoryStore());
    const response = await app.request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: "eveland-api" });
  });

  test("creates a project and returns it in the project list", async () => {
    const app = createApp(createMemoryStore());

    const createResponse = await app.request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Weather Agent", importKind: "git", gitUrl: "https://example.com/weather.git" }),
    });

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    expect(created.project).toMatchObject({
      name: "Weather Agent",
      importKind: "git",
      status: "import_pending",
    });

    const listResponse = await app.request("/projects");
    await expect(listResponse.json()).resolves.toMatchObject({
      projects: [expect.objectContaining({ id: created.project.id, name: "Weather Agent" })],
    });
  });

  test("creates a zip project from an uploaded archive and stores the extracted source path", async () => {
    const store = createMemoryStore();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "eveland-api-data-"));
    const archivePath = await createZipArchiveFixture();
    const archive = new File([await readFile(archivePath)], "agent.zip", { type: "application/zip" });
    const form = new FormData();
    form.set("name", "Zip Agent");
    form.set("archive", archive);
    const app = createApp(store, { dataDir });

    const response = await app.request("/projects", {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      project: expect.objectContaining({
        name: "Zip Agent",
        importKind: "zip",
        status: "import_pending",
      }),
    });
    const job = await store.claimNextJob("test-worker");
    const sourcePath = job?.payload.sourcePath;
    expect(sourcePath).toEqual(expect.stringContaining(path.join(dataDir, "uploads")));
    await expect(readFile(path.join(String(sourcePath), "agent", "instructions.md"), "utf8")).resolves.toBe("You are a helpful test agent.");
  });

  test("uses the only top-level directory in a zip archive as the source root", async () => {
    const store = createMemoryStore();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "eveland-api-data-"));
    const archivePath = await createZipArchiveFixture({ wrappedDirectory: "helloworld" });
    const archive = new File([await readFile(archivePath)], "helloworld.zip", { type: "application/zip" });
    const form = new FormData();
    form.set("name", "Wrapped Zip Agent");
    form.set("archive", archive);
    const app = createApp(store, { dataDir });

    const response = await app.request("/projects", {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(201);
    const job = await store.claimNextJob("test-worker");
    const sourcePath = String(job?.payload.sourcePath);
    await expect(readFile(path.join(sourcePath, "agent", "instructions.md"), "utf8")).resolves.toBe("You are a helpful test agent.");
    expect(sourcePath.endsWith(`${path.sep}helloworld`)).toBe(true);
  });

  test("stores secrets without returning secret values", async () => {
    const app = createApp(createMemoryStore());
    const createProject = await app.request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Secret Agent", importKind: "zip" }),
    });
    const { project } = await createProject.json();

    const secretResponse = await app.request(`/projects/${project.id}/secrets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "OPENAI_API_KEY", value: "sk-test-123456" }),
    });

    expect(secretResponse.status).toBe(201);
    const body = await secretResponse.json();
    expect(body.secret).toMatchObject({ key: "OPENAI_API_KEY" });
    expect(JSON.stringify(body)).not.toContain("sk-test-123456");

    const listResponse = await app.request(`/projects/${project.id}/secrets`);
    expect(JSON.stringify(await listResponse.json())).not.toContain("sk-test-123456");
  });

  test("returns current source revision and files", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Source Agent", importKind: "zip" });
    await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/source",
      summary: { instructions: ["agent/instructions.md"] },
      envVars: ["OPENAI_API_KEY"],
      files: [{ path: "agent/instructions.md", content: "You are concise." }],
      schedules: [],
    });
    const app = createApp(store);

    await expect((await app.request(`/projects/${project.id}/source/revision`)).json()).resolves.toMatchObject({
      revision: expect.objectContaining({ sourcePath: "/tmp/source", envVars: ["OPENAI_API_KEY"] }),
    });
    await expect((await app.request(`/projects/${project.id}/source/files`)).json()).resolves.toMatchObject({
      files: [expect.objectContaining({ path: "agent/instructions.md" })],
    });
    await expect((await app.request(`/projects/${project.id}/source/file?path=agent%2Finstructions.md`)).json()).resolves.toMatchObject({
      file: expect.objectContaining({ content: "You are concise." }),
    });
  });

  test("runs playground messages against the current deployment and records a session timeline", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Playground Agent", importKind: "zip" });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/source",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/playground:rel_123",
      containerName: "eveland-playground",
      internalPort: 3000,
      hostPort: 41001,
    });
    const runnerCalls: unknown[] = [];
    const app = createApp(store, {
      async playgroundRunner(input) {
        runnerCalls.push(input);
        return {
          response: "Hello from deployment",
          eveSessionId: "eve_123",
          continuationToken: "continue_123",
          events: [{ type: "model_response", payload: { content: "Hello from deployment" } }],
        };
      },
    });

    const response = await app.request(`/projects/${project.id}/playground`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Hello" }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      session: expect.objectContaining({
        projectId: project.id,
        deploymentId: deployment.id,
        trigger: "playground",
        status: "completed",
        eveSessionId: "eve_123",
      }),
      events: [
        expect.objectContaining({ type: "message", payload: { role: "user", content: "Hello" } }),
        expect.objectContaining({ type: "model_response", payload: { content: "Hello from deployment" } }),
      ],
    });
    expect(runnerCalls).toEqual([expect.objectContaining({ message: "Hello", deployment: expect.objectContaining({ id: deployment.id }) })]);
    await expect(store.listSessions(project.id)).resolves.toEqual([expect.objectContaining({ trigger: "playground", status: "completed" })]);
  });

  test("syncs the latest git source by enqueuing an import_source job with a deploy chained", async () => {
    const store = createMemoryStore();
    const app = createApp(store);
    const createResponse = await app.request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Weather Agent", importKind: "git", gitUrl: "https://example.com/weather.git" }),
    });
    const { project } = await createResponse.json();

    const syncResponse = await app.request(`/projects/${project.id}/sync-source`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deploy: true }),
    });

    expect(syncResponse.status).toBe(202);
    await expect(syncResponse.json()).resolves.toMatchObject({
      job: expect.objectContaining({
        type: "import_source",
        status: "queued",
        payload: expect.objectContaining({
          gitUrl: "https://example.com/weather.git",
          deployAfterImport: true,
        }),
      }),
    });
  });

  test("syncs a git source without deploying when no deploy flag is sent", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Sync Agent", importKind: "git", gitUrl: "https://example.com/agent.git" });
    const app = createApp(store);

    const syncResponse = await app.request(`/projects/${project.id}/sync-source`, { method: "POST" });

    expect(syncResponse.status).toBe(202);
    await expect(syncResponse.json()).resolves.toMatchObject({
      job: expect.objectContaining({ type: "import_source", payload: expect.objectContaining({ deployAfterImport: false }) }),
    });
  });

  test("rejects a source sync for a zip project", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Zip Agent", importKind: "zip", sourcePath: "/tmp/zip" });
    const app = createApp(store);

    const response = await app.request(`/projects/${project.id}/sync-source`, { method: "POST" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("git projects") });
  });

  test("returns 404 when syncing a project that does not exist", async () => {
    const app = createApp(createMemoryStore());
    const response = await app.request("/projects/missing/sync-source", { method: "POST" });
    expect(response.status).toBe(404);
  });

  test("rejects playground messages when no deployment is running", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Idle Agent", importKind: "zip" });
    const app = createApp(store);

    const response = await app.request(`/projects/${project.id}/playground`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Hello" }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "No running deployment" });
  });
});

async function createZipArchiveFixture(options: { wrappedDirectory?: string } = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "eveland-zip-source-"));
  const sourceDir = path.join(root, "source");
  const projectDir = options.wrappedDirectory ? path.join(sourceDir, options.wrappedDirectory) : sourceDir;
  await mkdir(path.join(projectDir, "agent"), { recursive: true });
  await writeFile(path.join(projectDir, "package.json"), JSON.stringify({ name: "zip-agent" }));
  await writeFile(path.join(projectDir, "agent", "instructions.md"), "You are a helpful test agent.");
  const archivePath = path.join(root, "agent.zip");
  await execFileAsync("zip", ["-qr", archivePath, "."], { cwd: sourceDir });
  return archivePath;
}
