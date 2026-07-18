import { execFile } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test, vi } from "vitest";
import { createBuildInfo } from "@eveland/core/build-info";
import { createScheduleDispatchCredential } from "@eveland/core/server/scheduler-dispatch";
import {
  decryptSecretValue,
  type EncryptedSecret,
} from "@eveland/core/server/secrets";
import { createApp } from "./app.js";
import { createMemoryStore, type Store } from "@eveland/db";

import {
  createScheduleRunFixture,
  createZipArchiveFixture,
} from "./app.test-support.js";

describe("api app", () => {
  test("leaves token usage projection to the observer collector", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({
      name: "Token Agent",
      importKind: "zip",
    });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/source",
      summary: { eveVersion: "0.25.1" },
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
                usage: {
                  inputTokens: 90,
                  outputTokens: 10,
                  cacheReadTokens: 50,
                },
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
          status: "none",
          inputTokens: 0,
          outputTokens: 0,
          reportedSteps: 0,
        },
      },
    });
  });

  test("does not project model-step usage from the Playground transport stream", async () => {
    let streamResponse: ServerResponse | null = null;
    let markStepSent!: () => void;
    const stepSent = new Promise<void>((resolve) => {
      markStepSent = resolve;
    });
    const eveServer = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/eve/v1/session") {
        response.writeHead(202, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            sessionId: "eve_live_usage",
            continuationToken: "continue_live",
          }),
        );
        return;
      }
      if (
        request.method === "GET" &&
        request.url === "/eve/v1/session/eve_live_usage/stream"
      ) {
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
    await new Promise<void>((resolve) =>
      eveServer.listen(0, "127.0.0.1", resolve),
    );
    const address = eveServer.address();
    if (!address || typeof address === "string")
      throw new Error("Failed to bind the Eve fixture server.");

    const store = createMemoryStore();
    const project = await store.createProject({
      name: "Streaming Usage Agent",
      importKind: "zip",
    });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/source",
      summary: { eveVersion: "0.25.1" },
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
    const app = createApp(store, {
      async playgroundRunner({ onEvent }) {
        await onEvent?.({
          type: "step.completed",
          payload: {
            turnId: "turn_0",
            stepIndex: 0,
            usage: { inputTokens: 25, outputTokens: 5 },
          },
        });
        markStepSent();
        return {
          response: "Counted live",
          eveSessionId: "eve_live_usage",
          events: [],
        };
      },
    });
    const responsePromise = app.request(`/projects/${project.id}/playground`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Count while streaming" }),
    });

    try {
      await stepSent;
      await expect(store.listSessions(project.id)).resolves.toEqual([
        expect.objectContaining({
          usage: expect.objectContaining({
            status: "none",
            inputTokens: 0,
            outputTokens: 0,
          }),
        }),
      ]);

      expect((await responsePromise).status).toBe(201);
    } finally {
      (streamResponse as ServerResponse | null)?.end();
      await new Promise<void>((resolve, reject) =>
        eveServer.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test("serializes timeline writes from concurrent agent streams", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({
      name: "Concurrent Stream Agent",
      importKind: "zip",
    });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/source",
      summary: { eveVersion: "0.25.1" },
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
        return {
          response: "Concurrent streams complete",
          eveSessionId: "eve_concurrent",
          events: [],
        };
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

  test("leaves child-session usage attribution to the observer collector", async () => {
    const eveServer = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/eve/v1/session") {
        response.writeHead(202, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            sessionId: "eve_root",
            continuationToken: "continue_root",
          }),
        );
        return;
      }
      if (
        request.method === "GET" &&
        request.url === "/eve/v1/session/eve_root/stream"
      ) {
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.write(
          `${JSON.stringify({
            type: "session.started",
            data: {
              runtime: {
                agentId: "agent_root",
                agentName: "Root agent",
                eveVersion: "0.25.1",
                modelId: "test/root",
              },
            },
          })}\n`,
        );
        response.write(
          `${JSON.stringify({
            type: "subagent.called",
            data: {
              childSessionId: "eve_child",
              name: "researcher",
              callId: "call_1",
            },
          })}\n`,
        );
        setTimeout(() => {
          response.write(
            `${JSON.stringify({
              type: "step.completed",
              data: {
                turnId: "turn_0",
                stepIndex: 0,
                finishReason: "stop",
                usage: { inputTokens: 10, outputTokens: 2 },
              },
            })}\n`,
          );
          response.write(
            `${JSON.stringify({
              type: "message.completed",
              data: {
                turnId: "turn_0",
                stepIndex: 0,
                finishReason: "stop",
                message: "Root complete",
              },
            })}\n`,
          );
          response.write(
            `${JSON.stringify({ type: "turn.completed", data: { turnId: "turn_0", sequence: 0 } })}\n`,
          );
          response.end();
        }, 20);
        return;
      }
      if (
        request.method === "GET" &&
        request.url === "/eve/v1/session/eve_child/stream"
      ) {
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.write(
          `${JSON.stringify({
            type: "session.started",
            data: {
              runtime: {
                agentId: "agent_researcher",
                agentName: "Researcher",
                eveVersion: "0.25.1",
                modelId: "test/child",
              },
            },
          })}\n`,
        );
        response.write(
          `${JSON.stringify({
            type: "step.completed",
            data: {
              turnId: "turn_0",
              stepIndex: 0,
              finishReason: "stop",
              usage: { inputTokens: 40, outputTokens: 5 },
            },
          })}\n`,
        );
        response.write(
          `${JSON.stringify({
            type: "message.completed",
            data: {
              turnId: "turn_0",
              stepIndex: 0,
              finishReason: "stop",
              message: "Child complete",
            },
          })}\n`,
        );
        response.write(
          `${JSON.stringify({ type: "turn.completed", data: { turnId: "turn_0", sequence: 0 } })}\n`,
        );
        response.end();
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) =>
      eveServer.listen(0, "127.0.0.1", resolve),
    );
    const address = eveServer.address();
    if (!address || typeof address === "string")
      throw new Error("Failed to bind the Eve subagent fixture server.");

    const store = createMemoryStore();
    const project = await store.createProject({
      name: "Subagent Usage Agent",
      importKind: "zip",
    });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/source",
      summary: { eveVersion: "0.25.1" },
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
      const response = await createApp(store, {
        playgroundRunner: async () => ({
          response: "Root complete",
          eveSessionId: "eve_root",
          events: [],
        }),
      }).request(`/projects/${project.id}/playground`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Delegate this" }),
      });
      expect(response.status).toBe(201);
      const [session] = await store.listSessions(project.id);
      expect(session?.usage).toMatchObject({
        status: "none",
        inputTokens: 0,
        outputTokens: 0,
        reportedSteps: 0,
      });
      await expect(store.listModelUsageEvents(session!.id)).resolves.toEqual(
        [],
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        eveServer.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test("returns per-agent model usage for a session", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({
      name: "Usage API Agent",
      importKind: "zip",
    });
    const session = await store.createSession({
      projectId: project.id,
      trigger: "playground",
    });
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

    const response = await createApp(store).request(
      `/sessions/${session.id}/usage`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      usage: [
        expect.objectContaining({
          eveSessionId: "eve_root",
          agentId: "agent_root",
          inputTokens: 20,
          outputTokens: 5,
        }),
      ],
    });
  });

  test("does not fail the root turn when a child stream is unavailable", async () => {
    const eveServer = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/eve/v1/session") {
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ sessionId: "eve_root_missing_child" }));
        return;
      }
      if (
        request.method === "GET" &&
        request.url === "/eve/v1/session/eve_root_missing_child/stream"
      ) {
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.write(
          `${JSON.stringify({ type: "subagent.called", data: { childSessionId: "eve_unavailable_child", name: "remote" } })}\n`,
        );
        response.write(
          `${JSON.stringify({
            type: "step.completed",
            data: {
              turnId: "turn_0",
              stepIndex: 0,
              finishReason: "stop",
              usage: { inputTokens: 8, outputTokens: 2 },
            },
          })}\n`,
        );
        response.write(
          `${JSON.stringify({
            type: "message.completed",
            data: {
              turnId: "turn_0",
              stepIndex: 0,
              finishReason: "stop",
              message: "Root still completed",
            },
          })}\n`,
        );
        response.write(
          `${JSON.stringify({ type: "turn.completed", data: { turnId: "turn_0", sequence: 0 } })}\n`,
        );
        response.end();
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) =>
      eveServer.listen(0, "127.0.0.1", resolve),
    );
    const address = eveServer.address();
    if (!address || typeof address === "string")
      throw new Error("Failed to bind the missing-child fixture server.");

    const store = createMemoryStore();
    const project = await store.createProject({
      name: "Missing Child Agent",
      importKind: "zip",
    });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/source",
      summary: { eveVersion: "0.25.1" },
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
      const response = await createApp(store, {
        playgroundRunner: async () => ({
          response: "Root still completed",
          eveSessionId: "eve_root_missing_child",
          events: [],
        }),
      }).request(`/projects/${project.id}/playground`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Continue without child telemetry" }),
      });

      expect(response.status).toBe(201);
      const [session] = await store.listSessions(project.id);
      expect(session?.usage).toMatchObject({
        status: "none",
        inputTokens: 0,
        outputTokens: 0,
      });
      await expect(
        store.listSessionEvents(session!.id),
      ).resolves.not.toContainEqual(
        expect.objectContaining({ type: "usage.collection_failed" }),
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        eveServer.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test("does not follow an untrusted remote subagent URL while collecting usage", async () => {
    let remoteRequests = 0;
    const remoteServer = createServer((_request, response) => {
      remoteRequests += 1;
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) =>
      remoteServer.listen(0, "127.0.0.1", resolve),
    );
    const remoteAddress = remoteServer.address();
    if (!remoteAddress || typeof remoteAddress === "string")
      throw new Error("Failed to bind the untrusted remote fixture.");

    const eveServer = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/eve/v1/session") {
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ sessionId: "eve_remote_parent" }));
        return;
      }
      if (
        request.method === "GET" &&
        request.url === "/eve/v1/session/eve_remote_parent/stream"
      ) {
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
            data: {
              turnId: "turn_0",
              stepIndex: 0,
              finishReason: "stop",
              message: "Parent complete",
            },
          })}\n`,
        );
        response.write(
          `${JSON.stringify({ type: "turn.completed", data: { turnId: "turn_0", sequence: 0 } })}\n`,
        );
        response.end();
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) =>
      eveServer.listen(0, "127.0.0.1", resolve),
    );
    const address = eveServer.address();
    if (!address || typeof address === "string")
      throw new Error("Failed to bind the remote-parent fixture.");

    const store = createMemoryStore();
    const project = await store.createProject({
      name: "Remote Boundary Agent",
      importKind: "zip",
    });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/source",
      summary: { eveVersion: "0.25.1" },
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
      const response = await createApp(store, {
        playgroundRunner: async () => ({
          response: "Remote not fetched",
          eveSessionId: "eve_remote_parent",
          events: [],
        }),
      }).request(`/projects/${project.id}/playground`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Do not fetch arbitrary hosts" }),
      });

      expect(response.status).toBe(201);
      expect(remoteRequests).toBe(0);
    } finally {
      await Promise.all([
        new Promise<void>((resolve, reject) =>
          eveServer.close((error) => (error ? reject(error) : resolve())),
        ),
        new Promise<void>((resolve, reject) =>
          remoteServer.close((error) => (error ? reject(error) : resolve())),
        ),
      ]);
    }
  });
});
