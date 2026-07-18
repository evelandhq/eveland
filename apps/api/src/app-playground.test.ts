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
  test("runs playground messages against the current deployment and records a session timeline", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({
      name: "Playground Agent",
      importKind: "zip",
    });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/source",
      summary: { eveVersion: "0.24.4" },
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
          events: [
            {
              type: "model_response",
              payload: { content: "Hello from deployment" },
            },
          ],
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
        status: "waiting",
        eveSessionId: "eve_123",
      }),
      events: [
        expect.objectContaining({
          type: "message",
          payload: { role: "user", content: "Hello" },
        }),
        expect.objectContaining({
          type: "model_response",
          payload: { content: "Hello from deployment" },
        }),
      ],
    });
    expect(runnerCalls).toEqual([
      expect.objectContaining({
        message: "Hello",
        deployment: expect.objectContaining({ id: deployment.id }),
      }),
    ]);
    await expect(store.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({ trigger: "playground", status: "waiting" }),
    ]);
  });

  test("lets the legacy Playground runner activate a dormant current Deployment", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({
      name: "Dormant Legacy Playground Agent",
      importKind: "zip",
    });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/dormant-legacy-playground",
      summary: { eveVersion: "0.24.4" },
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/playground:legacy-dormant",
      containerName: "eveland-playground-legacy-dormant",
      internalPort: 3000,
      hostPort: 41007,
      runtimeKind: "docker",
    });
    await store.updateDeploymentStatus(deployment.id, "stopped");
    const playgroundRunner = vi.fn(async () => ({
      response: "Awake",
      eveSessionId: "eve_legacy_dormant",
      continuationToken: "continue_legacy_dormant",
    }));
    const app = createApp(store, { playgroundRunner });

    const response = await app.request(`/projects/${project.id}/playground`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Wake legacy" }),
    });

    expect(response.status).toBe(201);
    expect(playgroundRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        deployment: expect.objectContaining({
          id: deployment.id,
          status: "stopped",
        }),
        message: "Wake legacy",
      }),
    );
  });

  test("forwards a canonical Playground session request when the current Deployment is dormant", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({
      name: "Dormant Playground Agent",
      importKind: "zip",
    });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/dormant-playground",
      summary: { eveVersion: "0.24.4" },
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/playground:dormant",
      containerName: "eveland-playground-dormant",
      internalPort: 3000,
      hostPort: 41004,
      runtimeKind: "docker",
    });
    await store.updateDeploymentStatus(deployment.id, "stopped");
    const playgroundProxy = vi.fn(async () => {
      await store.bindSession({
        projectId: project.id,
        eveSessionId: "eve_dormant",
        routeId: "route_dormant",
        deploymentId: deployment.id,
        trigger: "playground",
        variantName: null,
        experimentId: null,
        requestId: "req_dormant",
        remoteIp: null,
        affinityFingerprint: null,
        affinitySource: null,
      });
      return new Response(
        JSON.stringify({
          sessionId: "eve_dormant",
          continuationToken: "continue_dormant",
        }),
        {
          status: 202,
          headers: {
            "content-type": "application/json",
            "x-eve-session-id": "eve_dormant",
          },
        },
      );
    });
    const app = createApp(store, { playgroundProxy });

    const response = await app.request(
      `/projects/${project.id}/playground/eve/v1/session`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Wake up" }),
      },
    );

    expect(response.status).toBe(202);
    expect(playgroundProxy).toHaveBeenCalledOnce();
    await expect(store.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({
        eveSessionId: "eve_dormant",
        deploymentId: deployment.id,
        status: "running",
      }),
    ]);
  });

  test("attributes a canonical Playground Session to the Gateway-selected Deployment", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({
      name: "Routed Playground Agent",
      importKind: "zip",
    });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/routed-playground",
      summary: { eveVersion: "0.24.4" },
      envVars: [],
      files: [],
      schedules: [],
    });
    const projectCurrentDeployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/playground:current",
      containerName: "eveland-playground-current",
      internalPort: 3000,
      hostPort: 41005,
      runtimeKind: "docker",
    });
    const gatewaySelectedDeployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/playground:selected",
      containerName: "eveland-playground-selected",
      internalPort: 3000,
      hostPort: 41006,
      runtimeKind: "docker",
    });
    const app = createApp(store, {
      async playgroundProxy() {
        await store.bindSession({
          projectId: project.id,
          eveSessionId: "eve_routed",
          routeId: "route_weighted",
          deploymentId: gatewaySelectedDeployment.id,
          trigger: "playground",
          variantName: "selected",
          experimentId: "route_weighted:r2",
          requestId: "req_routed",
          remoteIp: null,
          affinityFingerprint: null,
          affinitySource: null,
        });
        return new Response(
          JSON.stringify({
            sessionId: "eve_routed",
            continuationToken: "continue_routed",
          }),
          {
            status: 202,
            headers: {
              "content-type": "application/json",
              "x-eve-session-id": "eve_routed",
            },
          },
        );
      },
    });

    const response = await app.request(
      `/projects/${project.id}/playground/eve/v1/session`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Use the selected variant" }),
      },
    );

    expect(response.status).toBe(202);
    await expect(store.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({
        eveSessionId: "eve_routed",
        deploymentId: gatewaySelectedDeployment.id,
        routeId: "route_weighted",
        experimentId: "route_weighted:r2",
        variantName: "selected",
      }),
    ]);
    await expect(store.getCurrentDeployment(project.id)).resolves.toMatchObject(
      { id: projectCurrentDeployment.id },
    );
    expect(gatewaySelectedDeployment.id).not.toBe(projectCurrentDeployment.id);
  });

  test("keeps one platform Session across streamed Playground turns and HITL continuation", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({
      name: "Streaming Playground Agent",
      importKind: "zip",
    });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/source",
      summary: { eveVersion: "0.24.4" },
      envVars: [],
      files: [],
      schedules: [],
    });
    await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/playground:streaming",
      containerName: "eveland-playground-streaming",
      internalPort: 3000,
      hostPort: 41003,
      runtimeKind: "docker",
    });
    const proxyCalls: Array<{ method: string; path: string; body: string }> =
      [];
    let cancelCalls = 0;
    const app = createApp(store, {
      async playgroundProxy(input) {
        const body = input.body ? new TextDecoder().decode(input.body) : "";
        proxyCalls.push({ method: input.method, path: input.path, body });
        if (input.method === "POST" && input.path === "/eve/v1/session") {
          return new Response(
            JSON.stringify({
              sessionId: "eve_chat",
              continuationToken: "continue_1",
            }),
            {
              status: 202,
              headers: {
                "content-type": "application/json",
                "x-eve-session-id": "eve_chat",
              },
            },
          );
        }
        if (
          input.method === "GET" &&
          input.path === "/eve/v1/session/eve_chat/stream"
        ) {
          return new Response(
            [
              {
                type: "reasoning.appended",
                data: {
                  reasoningDelta: "Checking",
                  reasoningSoFar: "Checking",
                },
              },
              {
                type: "input.requested",
                data: {
                  requests: [
                    {
                      requestId: "request_1",
                      prompt: "Run the tool?",
                      action: {
                        kind: "tool-call",
                        callId: "call_1",
                        toolName: "deploy",
                        input: { target: "preview" },
                      },
                      options: [
                        { id: "approve", label: "Approve" },
                        { id: "reject", label: "Reject", style: "danger" },
                      ],
                    },
                  ],
                  sequence: 1,
                  stepIndex: 0,
                  turnId: "turn_1",
                },
              },
              { type: "session.waiting", data: { wait: "next-user-message" } },
            ]
              .map((event) => JSON.stringify(event))
              .join("\n") + "\n",
            {
              status: 200,
              headers: { "content-type": "application/x-ndjson" },
            },
          );
        }
        if (
          input.method === "POST" &&
          input.path === "/eve/v1/session/eve_chat"
        ) {
          return new Response(
            JSON.stringify({
              sessionId: "eve_chat",
              continuationToken: "continue_2",
            }),
            {
              status: 202,
              headers: {
                "content-type": "application/json",
                "x-eve-session-id": "eve_chat",
              },
            },
          );
        }
        if (
          input.method === "POST" &&
          input.path === "/eve/v1/session/eve_chat/cancel"
        ) {
          cancelCalls += 1;
          if (cancelCalls > 1)
            return new Response("not found", { status: 404 });
          return Response.json(
            { sessionId: "eve_chat", status: "accepted" },
            { status: 202 },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });
    const attachmentData = "data:text/plain;base64,aGk=";
    const initialBody = JSON.stringify({
      message: [
        { type: "text", text: "Read this" },
        {
          type: "file",
          data: attachmentData,
          filename: "note.txt",
          mediaType: "text/plain",
        },
      ],
    });

    const initial = await app.request(
      `/projects/${project.id}/playground/eve/v1/session`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: initialBody,
      },
    );
    const stream = await app.request(
      `/projects/${project.id}/playground/eve/v1/session/eve_chat/stream`,
      {
        headers: { accept: "application/x-ndjson" },
      },
    );

    expect(initial.status).toBe(202);
    await expect(initial.json()).resolves.toMatchObject({
      sessionId: "eve_chat",
      continuationToken: "continue_1",
    });
    expect(stream.status).toBe(200);
    await expect(stream.text()).resolves.toContain("input.requested");
    await expect(store.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({
        eveSessionId: "eve_chat",
        status: "waiting_approval",
        continuationToken: "continue_1",
        completedAt: null,
      }),
    ]);
    const [platformSession] = await store.listSessions(project.id);
    expect(
      JSON.stringify(await store.listSessionEvents(platformSession!.id)),
    ).not.toContain(attachmentData);

    const continuationBody = JSON.stringify({
      continuationToken: "continue_1",
      inputResponses: [{ requestId: "request_1", optionId: "approve" }],
    });
    const continuation = await app.request(
      `/projects/${project.id}/playground/eve/v1/session/eve_chat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: continuationBody,
      },
    );

    expect(continuation.status).toBe(202);
    await expect(continuation.json()).resolves.toMatchObject({
      continuationToken: "continue_2",
    });
    const cancelBody = JSON.stringify({ turnId: "turn_1" });
    const cancel = await app.request(
      `/projects/${project.id}/playground/eve/v1/session/eve_chat/cancel`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: cancelBody,
      },
    );
    expect(cancel.status).toBe(202);
    await expect(cancel.json()).resolves.toEqual({
      sessionId: "eve_chat",
      status: "accepted",
    });
    const unsupportedCancel = await app.request(
      `/projects/${project.id}/playground/eve/v1/session/eve_chat/cancel`,
      {
        method: "POST",
      },
    );
    expect(unsupportedCancel.status).toBe(404);
    await expect(store.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({
        eveSessionId: "eve_chat",
        status: "running",
        continuationToken: "continue_2",
      }),
    ]);
    expect(proxyCalls).toEqual([
      { method: "POST", path: "/eve/v1/session", body: initialBody },
      { method: "GET", path: "/eve/v1/session/eve_chat/stream", body: "" },
      {
        method: "POST",
        path: "/eve/v1/session/eve_chat",
        body: continuationBody,
      },
      {
        method: "POST",
        path: "/eve/v1/session/eve_chat/cancel",
        body: cancelBody,
      },
      { method: "POST", path: "/eve/v1/session/eve_chat/cancel", body: "" },
    ]);
  });

  test("reports the deployed Eve version and rejects pinned unsupported Playground sessions", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({
      name: "Old Eve Playground Agent",
      importKind: "zip",
    });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/old-eve-playground-agent",
      summary: {},
      envVars: [],
      files: [
        {
          path: "package.json",
          content: JSON.stringify({ dependencies: { eve: "0.22.6" } }),
        },
      ],
      schedules: [],
    });
    const oldDeployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/old-eve:release",
      containerName: "eveland-old-eve",
      internalPort: 3000,
      hostPort: 41008,
      runtimeKind: "docker",
    });
    const playgroundProxy = vi.fn(async () =>
      Response.json(
        {
          error: "Unsupported Eve version",
          detail:
            'Unsupported Eve dependency "0.22.6". Eveland requires Eve 0.24.x.',
        },
        { status: 409 },
      ),
    );
    const app = createApp(store, { playgroundProxy });

    const version = await app.request(`/projects/${project.id}/eve-version`);
    expect(version.status).toBe(200);
    await expect(version.json()).resolves.toEqual({
      eveVersion: {
        version: "0.22.6",
        expected: "0.24.x",
        supported: false,
        sourceRevisionId: revision.id,
      },
    });

    const playground = await app.request(
      `/projects/${project.id}/playground/eve/v1/session`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      },
    );
    expect(playground.status).toBe(409);
    await expect(playground.json()).resolves.toMatchObject({
      error: "Unsupported Eve version",
    });
    expect(playgroundProxy).toHaveBeenCalledOnce();
    await expect(store.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({ deploymentId: null, status: "failed" }),
    ]);

    const supportedRevision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/current-eve-playground-agent",
      summary: { eveVersion: "0.24.4" },
      envVars: [],
      files: [],
      schedules: [],
    });
    const supportedDeployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: supportedRevision.id,
      imageTag: "eveland/current-eve:release",
      containerName: "eveland-current-eve",
      internalPort: 3000,
      hostPort: 41009,
      runtimeKind: "docker",
    });
    await store.ensureDeploymentRoutes(
      project.id,
      supportedDeployment.id,
      "agent.localhost",
    );
    await store.promoteDeployment(project.id, supportedDeployment.id);
    const pinnedOldSession = await store.createSession({
      projectId: project.id,
      deploymentId: oldDeployment.id,
      trigger: "playground",
    });
    await store.completeSession(pinnedOldSession.id, {
      status: "waiting",
      eveSessionId: "eve_old_pinned",
      continuationToken: "continue_old",
    });
    const pinnedContinuation = await app.request(
      `/projects/${project.id}/playground/eve/v1/session/eve_old_pinned`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          continuationToken: "continue_old",
          message: "continue",
        }),
      },
    );
    expect(pinnedContinuation.status).toBe(409);
    await expect(pinnedContinuation.json()).resolves.toMatchObject({
      error: "Unsupported Eve version",
    });
    const pinnedCancel = await app.request(
      `/projects/${project.id}/playground/eve/v1/session/eve_old_pinned/cancel`,
      {
        method: "POST",
      },
    );
    expect(pinnedCancel.status).toBe(409);
    await expect(pinnedCancel.json()).resolves.toMatchObject({
      error: "Unsupported Eve version",
    });
    expect(playgroundProxy).toHaveBeenCalledOnce();
  });
});
