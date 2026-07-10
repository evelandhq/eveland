import { execFile } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test, vi } from "vitest";
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
      runtimeKind: "docker",
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

  test("records token usage from completed Eve model steps", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Token Agent", importKind: "zip" });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/source",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/token:rel_123",
      containerName: "eveland-token",
      internalPort: 3000,
      hostPort: 41002,
      runtimeKind: "docker",
    });
    const app = createApp(store, {
      async playgroundRunner() {
        return {
          response: "Counted",
          eveSessionId: "eve_usage",
          events: [
            {
              type: "step.completed",
              payload: {
                turnId: "turn_0",
                stepIndex: 0,
                finishReason: "stop",
                usage: { inputTokens: 90, outputTokens: 10, cacheReadTokens: 50 },
              },
            },
            { type: "model_response", payload: { content: "Counted" } },
          ],
        };
      },
    });

    const response = await app.request(`/projects/${project.id}/playground`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Count this" }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      session: {
        usage: {
          status: "reported",
          inputTokens: 90,
          outputTokens: 10,
          cacheReadTokens: 50,
          cacheWriteTokens: 0,
          costUsd: null,
          reportedSteps: 1,
          missingSteps: 0,
        },
      },
    });
  });

  test("persists model-step usage before the Eve turn finishes", async () => {
    let streamResponse: ServerResponse | null = null;
    let markStepSent!: () => void;
    const stepSent = new Promise<void>((resolve) => {
      markStepSent = resolve;
    });
    const eveServer = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/eve/v1/session") {
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ sessionId: "eve_live_usage", continuationToken: "continue_live" }));
        return;
      }
      if (request.method === "GET" && request.url === "/eve/v1/session/eve_live_usage/stream") {
        streamResponse = response;
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.write(
          `${JSON.stringify({
            type: "step.completed",
            data: {
              turnId: "turn_0",
              stepIndex: 0,
              finishReason: "stop",
              usage: { inputTokens: 25, outputTokens: 5 },
            },
          })}\n`,
        );
        markStepSent();
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => eveServer.listen(0, "127.0.0.1", resolve));
    const address = eveServer.address();
    if (!address || typeof address === "string") throw new Error("Failed to bind the Eve fixture server.");

    const store = createMemoryStore();
    const project = await store.createProject({ name: "Streaming Usage Agent", importKind: "zip" });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/source",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/streaming-usage:rel_123",
      containerName: "eveland-streaming-usage",
      internalPort: 3000,
      hostPort: address.port,
      runtimeKind: "docker",
    });
    const app = createApp(store);
    const responsePromise = app.request(`/projects/${project.id}/playground`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Count while streaming" }),
    });

    try {
      await stepSent;
      await vi.waitFor(async () => {
        await expect(store.listSessions(project.id)).resolves.toEqual([
          expect.objectContaining({ usage: expect.objectContaining({ inputTokens: 25, outputTokens: 5 }) }),
        ]);
      });

      streamResponse!.write(
        `${JSON.stringify({
          type: "message.completed",
          data: { turnId: "turn_0", stepIndex: 0, finishReason: "stop", message: "Counted live" },
        })}\n`,
      );
      streamResponse!.write(`${JSON.stringify({ type: "turn.completed", data: { turnId: "turn_0", sequence: 0 } })}\n`);
      streamResponse!.end();

      expect((await responsePromise).status).toBe(201);
    } finally {
      (streamResponse as ServerResponse | null)?.end();
      await new Promise<void>((resolve, reject) => eveServer.close((error) => (error ? reject(error) : resolve())));
    }
  });

  test("serializes timeline writes from concurrent agent streams", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Concurrent Stream Agent", importKind: "zip" });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/source",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/concurrent-stream:rel_123",
      containerName: "eveland-concurrent-stream",
      internalPort: 3000,
      hostPort: 41003,
      runtimeKind: "docker",
    });

    const appendSessionEvent = store.appendSessionEvent;
    let activeWrites = 0;
    let maxActiveWrites = 0;
    store.appendSessionEvent = async (...args) => {
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      await new Promise((resolve) => setTimeout(resolve, 10));
      try {
        return await appendSessionEvent(...args);
      } finally {
        activeWrites -= 1;
      }
    };

    const app = createApp(store, {
      async playgroundRunner({ onEvent }) {
        await Promise.all([
          onEvent?.({ type: "agent.root", payload: { sequence: 1 } }),
          onEvent?.({ type: "agent.child", payload: { sequence: 2 } }),
        ]);
        return { response: "Concurrent streams complete", eveSessionId: "eve_concurrent", events: [] };
      },
    });

    const response = await app.request(`/projects/${project.id}/playground`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Run together" }),
    });

    expect(response.status).toBe(201);
    expect(maxActiveWrites).toBe(1);
  });

  test("attributes usage from child session streams to the subagent that consumed it", async () => {
    const eveServer = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/eve/v1/session") {
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ sessionId: "eve_root", continuationToken: "continue_root" }));
        return;
      }
      if (request.method === "GET" && request.url === "/eve/v1/session/eve_root/stream") {
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.write(
          `${JSON.stringify({
            type: "session.started",
            data: { runtime: { agentId: "agent_root", agentName: "Root agent", eveVersion: "0.22.1", modelId: "test/root" } },
          })}\n`,
        );
        response.write(
          `${JSON.stringify({
            type: "subagent.called",
            data: { childSessionId: "eve_child", name: "researcher", callId: "call_1" },
          })}\n`,
        );
        setTimeout(() => {
          response.write(
            `${JSON.stringify({
              type: "step.completed",
              data: { turnId: "turn_0", stepIndex: 0, finishReason: "stop", usage: { inputTokens: 10, outputTokens: 2 } },
            })}\n`,
          );
          response.write(
            `${JSON.stringify({
              type: "message.completed",
              data: { turnId: "turn_0", stepIndex: 0, finishReason: "stop", message: "Root complete" },
            })}\n`,
          );
          response.write(`${JSON.stringify({ type: "turn.completed", data: { turnId: "turn_0", sequence: 0 } })}\n`);
          response.end();
        }, 20);
        return;
      }
      if (request.method === "GET" && request.url === "/eve/v1/session/eve_child/stream") {
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.write(
          `${JSON.stringify({
            type: "session.started",
            data: { runtime: { agentId: "agent_researcher", agentName: "Researcher", eveVersion: "0.22.1", modelId: "test/child" } },
          })}\n`,
        );
        response.write(
          `${JSON.stringify({
            type: "step.completed",
            data: { turnId: "turn_0", stepIndex: 0, finishReason: "stop", usage: { inputTokens: 40, outputTokens: 5 } },
          })}\n`,
        );
        response.write(
          `${JSON.stringify({
            type: "message.completed",
            data: { turnId: "turn_0", stepIndex: 0, finishReason: "stop", message: "Child complete" },
          })}\n`,
        );
        response.write(`${JSON.stringify({ type: "turn.completed", data: { turnId: "turn_0", sequence: 0 } })}\n`);
        response.end();
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => eveServer.listen(0, "127.0.0.1", resolve));
    const address = eveServer.address();
    if (!address || typeof address === "string") throw new Error("Failed to bind the Eve subagent fixture server.");

    const store = createMemoryStore();
    const project = await store.createProject({ name: "Subagent Usage Agent", importKind: "zip" });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/source",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/subagent-usage:rel_123",
      containerName: "eveland-subagent-usage",
      internalPort: 3000,
      hostPort: address.port,
      runtimeKind: "docker",
    });

    try {
      const response = await createApp(store).request(`/projects/${project.id}/playground`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Delegate this" }),
      });
      expect(response.status).toBe(201);
      const [session] = await store.listSessions(project.id);
      expect(session?.usage).toMatchObject({ inputTokens: 50, outputTokens: 7, reportedSteps: 2 });
      await expect(store.listModelUsageEvents(session!.id)).resolves.toEqual([
        expect.objectContaining({ eveSessionId: "eve_child", agentId: "agent_researcher", agentName: "Researcher", inputTokens: 40 }),
        expect.objectContaining({ eveSessionId: "eve_root", agentId: "agent_root", agentName: "Root agent", inputTokens: 10 }),
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => eveServer.close((error) => (error ? reject(error) : resolve())));
    }
  });

  test("returns per-agent model usage for a session", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Usage API Agent", importKind: "zip" });
    const session = await store.createSession({ projectId: project.id, trigger: "playground" });
    await store.recordModelUsage(session.id, {
      eveSessionId: "eve_root",
      agentId: "agent_root",
      agentName: "Root agent",
      turnId: "turn_0",
      stepIndex: 0,
      finishReason: "stop",
      inputTokens: 20,
      outputTokens: 5,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
      usageReported: true,
    });

    const response = await createApp(store).request(`/sessions/${session.id}/usage`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      usage: [expect.objectContaining({ eveSessionId: "eve_root", agentId: "agent_root", inputTokens: 20, outputTokens: 5 })],
    });
  });

  test("does not fail the root turn when a child usage stream cannot be collected", async () => {
    const eveServer = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/eve/v1/session") {
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ sessionId: "eve_root_missing_child" }));
        return;
      }
      if (request.method === "GET" && request.url === "/eve/v1/session/eve_root_missing_child/stream") {
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.write(
          `${JSON.stringify({ type: "subagent.called", data: { childSessionId: "eve_unavailable_child", name: "remote" } })}\n`,
        );
        response.write(
          `${JSON.stringify({
            type: "step.completed",
            data: { turnId: "turn_0", stepIndex: 0, finishReason: "stop", usage: { inputTokens: 8, outputTokens: 2 } },
          })}\n`,
        );
        response.write(
          `${JSON.stringify({
            type: "message.completed",
            data: { turnId: "turn_0", stepIndex: 0, finishReason: "stop", message: "Root still completed" },
          })}\n`,
        );
        response.write(`${JSON.stringify({ type: "turn.completed", data: { turnId: "turn_0", sequence: 0 } })}\n`);
        response.end();
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => eveServer.listen(0, "127.0.0.1", resolve));
    const address = eveServer.address();
    if (!address || typeof address === "string") throw new Error("Failed to bind the missing-child fixture server.");

    const store = createMemoryStore();
    const project = await store.createProject({ name: "Missing Child Agent", importKind: "zip" });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/source",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/missing-child:rel_123",
      containerName: "eveland-missing-child",
      internalPort: 3000,
      hostPort: address.port,
      runtimeKind: "docker",
    });

    try {
      const response = await createApp(store).request(`/projects/${project.id}/playground`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Continue without child telemetry" }),
      });

      expect(response.status).toBe(201);
      const [session] = await store.listSessions(project.id);
      expect(session?.usage).toMatchObject({ inputTokens: 8, outputTokens: 2 });
      await expect(store.listSessionEvents(session!.id)).resolves.toContainEqual(
        expect.objectContaining({ type: "usage.collection_failed", payload: expect.objectContaining({ eveSessionId: "eve_unavailable_child" }) }),
      );
    } finally {
      await new Promise<void>((resolve, reject) => eveServer.close((error) => (error ? reject(error) : resolve())));
    }
  });

  test("does not follow an untrusted remote subagent URL while collecting usage", async () => {
    let remoteRequests = 0;
    const remoteServer = createServer((_request, response) => {
      remoteRequests += 1;
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => remoteServer.listen(0, "127.0.0.1", resolve));
    const remoteAddress = remoteServer.address();
    if (!remoteAddress || typeof remoteAddress === "string") throw new Error("Failed to bind the untrusted remote fixture.");

    const eveServer = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/eve/v1/session") {
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ sessionId: "eve_remote_parent" }));
        return;
      }
      if (request.method === "GET" && request.url === "/eve/v1/session/eve_remote_parent/stream") {
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.write(
          `${JSON.stringify({
            type: "subagent.called",
            data: {
              childSessionId: "eve_remote_child",
              name: "external",
              remote: { url: `http://127.0.0.1:${remoteAddress.port}` },
            },
          })}\n`,
        );
        response.write(
          `${JSON.stringify({
            type: "message.completed",
            data: { turnId: "turn_0", stepIndex: 0, finishReason: "stop", message: "Parent complete" },
          })}\n`,
        );
        response.write(`${JSON.stringify({ type: "turn.completed", data: { turnId: "turn_0", sequence: 0 } })}\n`);
        response.end();
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => eveServer.listen(0, "127.0.0.1", resolve));
    const address = eveServer.address();
    if (!address || typeof address === "string") throw new Error("Failed to bind the remote-parent fixture.");

    const store = createMemoryStore();
    const project = await store.createProject({ name: "Remote Boundary Agent", importKind: "zip" });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/source",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/remote-boundary:rel_123",
      containerName: "eveland-remote-boundary",
      internalPort: 3000,
      hostPort: address.port,
      runtimeKind: "docker",
    });

    try {
      const response = await createApp(store).request(`/projects/${project.id}/playground`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Do not fetch arbitrary hosts" }),
      });

      expect(response.status).toBe(201);
      expect(remoteRequests).toBe(0);
    } finally {
      await Promise.all([
        new Promise<void>((resolve, reject) => eveServer.close((error) => (error ? reject(error) : resolve()))),
        new Promise<void>((resolve, reject) => remoteServer.close((error) => (error ? reject(error) : resolve()))),
      ]);
    }
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

  test("returns 404 when deleting a project that does not exist", async () => {
    const app = createApp(createMemoryStore());

    const response = await app.request("/projects/missing", { method: "DELETE" });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Project not found" });
  });

  test("enqueues a delete_project job and leaves the project in place until the worker runs it", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Delete Me Agent", importKind: "zip", sourcePath: "/tmp/delete-me" });
    const app = createApp(store);

    const response = await app.request(`/projects/${project.id}`, { method: "DELETE" });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      job: expect.objectContaining({ type: "delete_project", status: "queued", projectId: project.id }),
    });
    // The delete only happens once the worker processes the job; the DELETE
    // request itself must not remove the project row.
    await expect(store.getProject(project.id)).resolves.toMatchObject({ id: project.id });
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
