import { describe, expect, test, vi } from "vitest";
import { createApp } from "./app.js";
import { createTestStore } from "@evelandhq/db/vitest";

describe("api app", () => {
  test("forwards a canonical Playground session request when the current Deployment is dormant", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Dormant Playground Agent",
      importKind: "zip",
    });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/dormant-playground",
      summary: { eveVersion: "1.0.0-rc.2" },
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
    const [route] = await store.ensureDeploymentRoutes(
      project.id,
      deployment.id,
      "agent.localhost",
    );
    const playgroundProxy = vi.fn(async () => {
      await store.bindSession({
        projectId: project.id,
        eveSessionId: "eve_dormant",
        routeId: route!.id,
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

    const response = await app.request(`/api/projects/${project.id}/playground/eve/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Wake up" }),
    });

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
    const store = createTestStore();
    const project = await store.createProject({
      name: "Routed Playground Agent",
      importKind: "zip",
    });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/routed-playground",
      summary: { eveVersion: "1.0.0-rc.2" },
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
    const [route] = await store.ensureDeploymentRoutes(
      project.id,
      projectCurrentDeployment.id,
      "agent.localhost",
    );
    const app = createApp(store, {
      async playgroundProxy() {
        await store.bindSession({
          projectId: project.id,
          eveSessionId: "eve_routed",
          routeId: route!.id,
          deploymentId: gatewaySelectedDeployment.id,
          trigger: "playground",
          variantName: "selected",
          experimentId: `${route!.id}:r2`,
          requestId: "req_routed",
          remoteIp: null,
          affinityFingerprint: null,
          affinitySource: null,
        });
        return new Response(
          JSON.stringify({
            sessionId: "eve_routed",
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

    const response = await app.request(`/api/projects/${project.id}/playground/eve/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Use the selected variant" }),
    });

    expect(response.status).toBe(202);
    await expect(store.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({
        eveSessionId: "eve_routed",
        deploymentId: gatewaySelectedDeployment.id,
        routeId: route!.id,
        experimentId: `${route!.id}:r2`,
        variantName: "selected",
      }),
    ]);
    await expect(store.getCurrentDeployment(project.id)).resolves.toMatchObject({
      id: projectCurrentDeployment.id,
    });
    expect(gatewaySelectedDeployment.id).not.toBe(projectCurrentDeployment.id);
  });

  test("keeps one platform Session across streamed Playground turns and HITL continuation", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Streaming Playground Agent",
      importKind: "zip",
    });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/source",
      summary: { eveVersion: "1.0.0-rc.2" },
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/playground:streaming",
      containerName: "eveland-playground-streaming",
      internalPort: 3000,
      hostPort: 41003,
      runtimeKind: "docker",
    });
    const [route] = await store.ensureDeploymentRoutes(
      project.id,
      deployment.id,
      "agent.localhost",
    );
    const proxyCalls: Array<{ method: string; path: string; body: string }> = [];
    let cancelCalls = 0;
    const app = createApp(store, {
      async playgroundProxy(input) {
        const body = input.body ? new TextDecoder().decode(input.body) : "";
        proxyCalls.push({ method: input.method, path: input.path, body });
        if (input.method === "POST" && input.path === "/eve/v1/session") {
          await store.bindSession({
            projectId: project.id,
            eveSessionId: "eve_chat",
            routeId: route!.id,
            deploymentId: deployment.id,
            trigger: "playground",
            variantName: null,
            experimentId: null,
            requestId: "req_streaming",
            remoteIp: null,
            affinityFingerprint: null,
            affinitySource: null,
          });
          return new Response(
            JSON.stringify({
              sessionId: "eve_chat",
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
          input.path === "/eve/v1/session/eve_chat/stream?startIndex=0&includeTailIndex=1"
        ) {
          return new Response(
            [
              {
                progress: {
                  type: "reasoning.delta",
                  scope: { turnId: "turn_1" },
                  data: { partId: "reasoning_1", delta: "Checking" },
                },
              },
              {
                at: "2026-11-02T00:00:00.000Z",
                facts: [
                  {
                    type: "interaction.opened",
                    scope: { turnId: "turn_1" },
                    data: {
                      interactionId: "int_1",
                      request: {
                        kind: "approval",
                        prompt: "Run the tool?",
                        callId: "call_1",
                        options: [
                          { id: "approve", label: "Approve" },
                          { id: "reject", label: "Reject", style: "danger" },
                        ],
                      },
                    },
                  },
                  {
                    type: "turn.paused",
                    scope: { turnId: "turn_1" },
                    data: { turnId: "turn_1", interactionIds: ["int_1"] },
                  },
                ],
              },
              { $eve: "position", next: 2 },
            ]
              .map((line) => JSON.stringify(line))
              .join("\n") + "\n",
            {
              status: 200,
              headers: {
                "content-type": "application/x-ndjson",
                "x-eve-stream-tail-index": "2",
              },
            },
          );
        }
        if (input.method === "POST" && input.path === "/eve/v1/session/eve_chat") {
          return new Response(
            JSON.stringify({
              sessionId: "eve_chat",
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
        if (input.method === "POST" && input.path === "/eve/v1/session/eve_chat/cancel") {
          cancelCalls += 1;
          if (cancelCalls > 1) return new Response("not found", { status: 404 });
          return Response.json({ sessionId: "eve_chat", status: "accepted" }, { status: 202 });
        }
        if (input.method === "POST" && input.path === "/eve/v1/session/eve_chat/reset") {
          return Response.json({ ok: true, sessionId: "eve_chat", deliveryId: "dlv_reset" });
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

    const initial = await app.request(`/api/projects/${project.id}/playground/eve/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: initialBody,
    });
    const stream = await app.request(
      `/api/projects/${project.id}/playground/eve/v1/session/eve_chat/stream?startIndex=0&includeTailIndex=1`,
      {
        headers: { accept: "application/x-ndjson" },
      },
    );

    expect(initial.status).toBe(202);
    await expect(initial.json()).resolves.toMatchObject({
      sessionId: "eve_chat",
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("x-eve-stream-tail-index")).toBe("2");
    await expect(stream.text()).resolves.toContain("interaction.opened");
    await expect(store.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({
        eveSessionId: "eve_chat",
        status: "waiting_approval",
        completedAt: null,
      }),
    ]);
    const [platformSession] = await store.listSessions(project.id);
    expect(JSON.stringify(await store.listSessionEvents(platformSession!.id))).not.toContain(
      attachmentData,
    );

    const continuationBody = JSON.stringify({
      answers: [{ interactionId: "int_1", optionId: "approve" }],
    });
    const continuation = await app.request(
      `/api/projects/${project.id}/playground/eve/v1/session/eve_chat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: continuationBody,
      },
    );

    expect(continuation.status).toBe(202);
    await expect(continuation.json()).resolves.toMatchObject({});
    const cancelBody = JSON.stringify({ turnId: "turn_1" });
    const cancel = await app.request(
      `/api/projects/${project.id}/playground/eve/v1/session/eve_chat/cancel`,
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
      `/api/projects/${project.id}/playground/eve/v1/session/eve_chat/cancel`,
      {
        method: "POST",
      },
    );
    expect(unsupportedCancel.status).toBe(404);
    const resetBody = "";
    const reset = await app.request(
      `/api/projects/${project.id}/playground/eve/v1/session/eve_chat/reset`,
      {
        method: "POST",
      },
    );
    expect(reset.status).toBe(200);
    await expect(reset.json()).resolves.toEqual({
      ok: true,
      sessionId: "eve_chat",
      deliveryId: "dlv_reset",
    });
    await expect(store.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({
        eveSessionId: "eve_chat",
        status: "completed",
      }),
    ]);
    expect(proxyCalls).toEqual([
      { method: "POST", path: "/eve/v1/session", body: initialBody },
      {
        method: "GET",
        path: "/eve/v1/session/eve_chat/stream?startIndex=0&includeTailIndex=1",
        body: "",
      },
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
      { method: "POST", path: "/eve/v1/session/eve_chat/reset", body: resetBody },
    ]);
  });

  test("reports the deployed Eve version, preferring the build-resolved one", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Eve Version Agent", importKind: "zip" });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/eve-version-agent",
      summary: {},
      envVars: [],
      files: [
        { path: "package.json", content: JSON.stringify({ dependencies: { eve: "^1.0.0" } }) },
      ],
      schedules: [],
    });
    const app = createApp(store);

    const declared = await app.request(`/api/projects/${project.id}/eve-version`);
    expect(declared.status).toBe(200);
    await expect(declared.json()).resolves.toEqual({
      eveVersion: { version: "^1.0.0", sourceRevisionId: revision.id },
    });

    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/eve-version:release",
      containerName: "eveland-eve-version",
      internalPort: 3000,
      hostPort: 41008,
      runtimeKind: "docker",
      summary: { eveVersionResolved: "1.0.0" },
    });
    await store.ensureDeploymentRoutes(project.id, deployment.id, "agent.localhost");
    await store.promoteDeployment(project.id, deployment.id);

    const resolved = await app.request(`/api/projects/${project.id}/eve-version`);
    await expect(resolved.json()).resolves.toEqual({
      eveVersion: { version: "1.0.0", sourceRevisionId: revision.id },
    });
  });
});
