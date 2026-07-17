import { decodeAgentAuthEnvelope } from "@eveland/core/agent-auth";
import { createMemoryStore } from "@eveland/db";
import { describe, expect, test } from "vitest";
import { createApp } from "./app.js";

const appSecretKey = "0123456789abcdef0123456789abcdef";

describe("Agent Auth control-plane routes", () => {
  test("lists generic methods and lazily creates a redacted local-dev Connection", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "connection-descriptor", importKind: "zip" });
    const app = createApp(store, { appSecretKey });

    const methods = await app.request("/agent-auth/methods");
    const response = await app.request(`/projects/${project.id}/playground/connection`);

    expect(methods.status).toBe(200);
    await expect(methods.json()).resolves.toMatchObject({
      methods: [
        expect.objectContaining({ method: "local-dev", credentialScope: "connection" }),
        expect.objectContaining({ method: "none", credentialScope: "connection" }),
        expect.objectContaining({ method: "basic", credentialScope: "connection" }),
        expect.objectContaining({ method: "bearer", credentialScope: "connection" }),
        expect.objectContaining({ method: "headers", credentialScope: "connection" }),
      ],
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      connection: {
        target: { kind: "managed-project", projectId: project.id },
        method: "local-dev",
        securityRevision: 1,
        config: {},
      },
      status: { state: "not_required" },
    });
    expect((await store.getProjectAgentConnection(project.id))?.configEncrypted).not.toBe("{}");
  });

  test("redacts secrets and only increments revision for semantic changes", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "bearer-control-plane", importKind: "zip" });
    const app = createApp(store, { appSecretKey });
    const initial = await app.request(`/projects/${project.id}/playground/connection`);
    const initialBody = await initial.json() as { connection: { id: string } };

    const configured = await app.request(`/agent-connections/${initialBody.connection.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedSecurityRevision: 1,
        method: "bearer",
        config: { token: "agent-token-must-stay-secret" },
      }),
    });
    const unchanged = await app.request(`/agent-connections/${initialBody.connection.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedSecurityRevision: 2, method: "bearer", config: {} }),
    });

    expect(configured.status).toBe(200);
    await expect(configured.json()).resolves.toMatchObject({
      connection: { method: "bearer", securityRevision: 2, config: { tokenConfigured: true } },
    });
    expect(unchanged.status).toBe(200);
    await expect(unchanged.json()).resolves.toMatchObject({ connection: { securityRevision: 2 } });
    expect((await store.getProjectAgentConnection(project.id))?.configEncrypted).not.toContain("agent-token-must-stay-secret");
  });

  test("rejects an unsafe custom credential header without changing the Connection", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "unsafe-header", importKind: "zip" });
    const app = createApp(store, { appSecretKey });
    const initial = await app.request(`/projects/${project.id}/playground/connection`);
    const body = await initial.json() as { connection: { id: string } };

    const response = await app.request(`/agent-connections/${body.connection.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedSecurityRevision: 1,
        method: "headers",
        config: { headers: { Host: "attacker.example" } },
      }),
    });

    expect(response.status).toBe(422);
    await expect(store.getProjectAgentConnection(project.id)).resolves.toMatchObject({ method: "local-dev", securityRevision: 1 });
  });

  test("resolves the current credential for every canonical Playground request", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "bearer-playground", importKind: "zip" });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/bearer-playground",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "bearer-playground",
      containerName: "bearer-playground",
      internalPort: 3000,
      hostPort: 41991,
      runtimeKind: "docker",
    });
    const seen: string[] = [];
    const app = createApp(store, {
      appSecretKey,
      playgroundProxy: async (input) => {
        seen.push(input.agentAuthEnvelope ?? "");
        return Response.json(
          { sessionId: "eve_protected", continuationToken: "continue_protected" },
          { status: 202, headers: { "x-eve-session-id": "eve_protected" } },
        );
      },
    });
    const initial = await app.request(`/projects/${project.id}/playground/connection`);
    const body = await initial.json() as { connection: { id: string } };
    await app.request(`/agent-connections/${body.connection.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedSecurityRevision: 1, method: "bearer", config: { token: "protected-token" } }),
    });

    const response = await app.request(`/projects/${project.id}/playground/eve/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });

    expect(response.status).toBe(202);
    expect(seen).toHaveLength(1);
    expect(decodeAgentAuthEnvelope(seen[0]!)).toEqual({
      version: 1,
      authority: "canonical",
      headers: [["authorization", "Bearer protected-token"]],
    });
  });
});
