import { describe, expect, test } from "vitest";
import { createTestStore } from "@eveland/db/vitest";
import { decryptSecretValue, encryptSecretValue, type EncryptedSecret } from "@eveland/core/server/secrets";
import { createApp } from "./app.js";
import { SHARED_AGENT_ENVIRONMENT_PROFILE_ID } from "@eveland/core/contracts";

const appSecretKey = "eveland-test-secret-key-00000000";

describe("platform Secret Profile routes", () => {
  test("creates, lists, and semantically updates profiles without exposing values", async () => {
    const store = createTestStore();
    const app = createApp(store, { appSecretKey });

    const createdResponse = await app.request("/platform/secret-profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Shared model credentials",
        entries: [
          { key: "MODEL_REGION", kind: "variable", value: "us-east-1" },
          { key: "OPENAI_API_KEY", kind: "secret", value: "sk-profile-secret" },
        ],
      }),
    });

    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { profile: { id: string; revision: number; entries: unknown[] } };
    expect(created.profile).toMatchObject({ revision: 1, entries: [
      { key: "MODEL_REGION", kind: "variable", configured: true },
      { key: "OPENAI_API_KEY", kind: "secret", configured: true },
    ] });
    expect(JSON.stringify(created)).not.toContain("us-east-1");
    expect(JSON.stringify(created)).not.toContain("sk-profile-secret");

    const listedResponse = await app.request("/platform/secret-profiles");
    expect(listedResponse.status).toBe(200);
    expect(JSON.stringify(await listedResponse.json())).not.toContain("sk-profile-secret");

    const unchangedResponse = await app.request(`/platform/secret-profiles/${created.profile.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Shared model credentials",
        entries: [
          { key: "OPENAI_API_KEY", kind: "secret" },
          { key: "MODEL_REGION", kind: "variable" },
        ],
      }),
    });
    expect(unchangedResponse.status).toBe(200);
    await expect(unchangedResponse.json()).resolves.toMatchObject({ profile: { revision: 1 } });

    const changedResponse = await app.request(`/platform/secret-profiles/${created.profile.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Shared model credentials",
        entries: [
          { key: "MODEL_REGION", kind: "variable" },
          { key: "OPENAI_API_KEY", kind: "secret", value: "sk-profile-rotated" },
        ],
      }),
    });
    expect(changedResponse.status).toBe(200);
    await expect(changedResponse.json()).resolves.toMatchObject({ profile: { revision: 2 } });

    const record = await store.getPlatformSecretProfileRecord(created.profile.id);
    const encrypted = JSON.parse(record!.entries.find((entry) => entry.key === "OPENAI_API_KEY")!.encryptedValue) as EncryptedSecret;
    expect(decryptSecretValue(encrypted, appSecretKey)).toBe("sk-profile-rotated");
  });

  test("binds profiles explicitly and queues only affected runtime restarts", async () => {
    const store = createTestStore();
    const app = createApp(store, { appSecretKey });
    const project = await store.createProject({ name: "Profile Restart Agent", importKind: "zip" });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/profile-restart-source",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const firstDeployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "profile:first",
      containerName: "profile-first",
      internalPort: 3000,
      hostPort: 42001,
      runtimeKind: "docker",
    });
    const secondDeployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "profile:second",
      containerName: "profile-second",
      internalPort: 3000,
      hostPort: 42002,
      runtimeKind: "docker",
    });
    const profile = await store.savePlatformSecretProfile({
      name: "Runtime binding profile",
      entries: [{
        key: "TOKEN",
        kind: "secret",
        encryptedValue: JSON.stringify(encryptSecretValue("runtime-profile-token", appSecretKey)),
      }],
    });

    const projectBindingResponse = await app.request(`/projects/${project.id}/platform-secret-bindings/agent-runtime`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId: profile.id, deploymentId: null }),
    });
    expect(projectBindingResponse.status).toBe(200);
    await expect(projectBindingResponse.json()).resolves.toMatchObject({
      binding: { profileId: profile.id, projectId: project.id, deploymentId: null, consumer: "agent-runtime" },
      jobs: expect.arrayContaining([
        expect.objectContaining({ payload: { deploymentId: firstDeployment.id, reason: "platform_secret_binding_changed" } }),
        expect.objectContaining({ payload: { deploymentId: secondDeployment.id, reason: "platform_secret_binding_changed" } }),
      ]),
    });

    const connectionBindingResponse = await app.request(`/projects/${project.id}/platform-secret-bindings/agent-connection`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId: profile.id, deploymentId: null }),
    });
    expect(connectionBindingResponse.status).toBe(200);
    await expect(connectionBindingResponse.json()).resolves.toMatchObject({ jobs: [] });

    const invalidConnectionBindingResponse = await app.request(`/projects/${project.id}/platform-secret-bindings/agent-connection`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId: profile.id, deploymentId: firstDeployment.id }),
    });
    expect(invalidConnectionBindingResponse.status).toBe(409);
    await expect(invalidConnectionBindingResponse.json()).resolves.toEqual({
      error: "Agent Connection Secret Profile bindings must be Project-scoped.",
    });

    const deploymentBindingResponse = await app.request(`/projects/${project.id}/platform-secret-bindings/agent-runtime`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId: profile.id, deploymentId: secondDeployment.id }),
    });
    expect(deploymentBindingResponse.status).toBe(200);
    await expect(deploymentBindingResponse.json()).resolves.toMatchObject({
      jobs: [expect.objectContaining({ payload: {
        deploymentId: secondDeployment.id,
        reason: "platform_secret_binding_changed",
      } })],
    });

    const rotatedResponse = await app.request(`/platform/secret-profiles/${profile.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: profile.name,
        entries: [{ key: "TOKEN", kind: "secret", value: "runtime-profile-token-v2" }],
      }),
    });
    expect(rotatedResponse.status).toBe(200);
    const rotated = await rotatedResponse.json() as { jobs: Array<{ payload: { deploymentId: string } }> };
    expect(rotated.jobs.map((job) => job.payload.deploymentId).sort()).toEqual([
      firstDeployment.id,
      secondDeployment.id,
    ].sort());

    const listedResponse = await app.request(`/projects/${project.id}/platform-secret-bindings`);
    expect(listedResponse.status).toBe(200);
    const listed = await listedResponse.json() as { bindings: Array<{ id: string; deploymentId: string | null; consumer: string }> };
    expect(JSON.stringify(listed)).not.toContain("runtime-profile-token");

    const deploymentBinding = listed.bindings.find((binding) =>
      binding.consumer === "agent-runtime" && binding.deploymentId === secondDeployment.id,
    );
    const unboundResponse = await app.request(
      `/projects/${project.id}/platform-secret-bindings/${deploymentBinding!.id}`,
      { method: "DELETE" },
    );
    expect(unboundResponse.status).toBe(200);
    await expect(unboundResponse.json()).resolves.toMatchObject({
      deleted: true,
      jobs: [expect.objectContaining({ payload: {
        deploymentId: secondDeployment.id,
        reason: "platform_secret_binding_changed",
      } })],
    });

    const deletedResponse = await app.request(`/platform/secret-profiles/${profile.id}`, { method: "DELETE" });
    expect(deletedResponse.status).toBe(200);
    const deleted = await deletedResponse.json() as { deleted: boolean; jobs: Array<{ payload: { deploymentId: string } }> };
    expect(deleted.deleted).toBe(true);
    expect(deleted.jobs.map((job) => job.payload.deploymentId).sort()).toEqual([
      firstDeployment.id,
      secondDeployment.id,
    ].sort());
  });
});

describe("shared Agent environment routes", () => {
  test("reads and saves the singleton environment without Profile metadata", async () => {
    const store = createTestStore();
    const app = createApp(store, { appSecretKey });

    const emptyResponse = await app.request("/platform/shared-agent-environment");
    expect(emptyResponse.status).toBe(200);
    await expect(emptyResponse.json()).resolves.toEqual({ environment: null });

    const savedResponse = await app.request("/platform/shared-agent-environment", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        entries: [
          { key: "MODEL_REGION", kind: "variable", value: "us-east-1" },
          { key: "OPENAI_API_KEY", kind: "secret", value: "sk-shared-secret" },
        ],
      }),
    });
    expect(savedResponse.status).toBe(200);
    const saved = await savedResponse.json() as Record<string, unknown>;
    expect(saved).toMatchObject({
      environment: {
        revision: 1,
        entries: [
          { key: "MODEL_REGION", kind: "variable", configured: true },
          { key: "OPENAI_API_KEY", kind: "secret", configured: true },
        ],
      },
      jobs: [],
    });
    expect(JSON.stringify(saved)).not.toContain("name");
    expect(JSON.stringify(saved)).not.toContain("profile");
    expect(JSON.stringify(saved)).not.toContain("us-east-1");
    expect(JSON.stringify(saved)).not.toContain("sk-shared-secret");

    const legacyProfilesResponse = await app.request("/platform/secret-profiles");
    expect(legacyProfilesResponse.status).toBe(200);
    await expect(legacyProfilesResponse.json()).resolves.toEqual({ profiles: [] });
    const legacyMutationResponse = await app.request(
      `/platform/secret-profiles/${SHARED_AGENT_ENVIRONMENT_PROFILE_ID}`,
      {
        method: "DELETE",
      },
    );
    expect(legacyMutationResponse.status).toBe(404);

    const record = await store.getSharedAgentEnvironmentRecord();
    const encrypted = JSON.parse(
      record!.entries.find((entry) => entry.key === "OPENAI_API_KEY")!.encryptedValue,
    ) as EncryptedSecret;
    expect(decryptSecretValue(encrypted, appSecretKey)).toBe("sk-shared-secret");
  });

  test("restarts every live Deployment when the global environment changes", async () => {
    const store = createTestStore();
    const app = createApp(store, { appSecretKey });
    const firstProject = await store.createProject({ name: "Shared Environment Restart Agent", importKind: "zip" });
    const firstRevision = await store.recordSourceRevision({
      projectId: firstProject.id,
      kind: "zip",
      sourcePath: "/tmp/shared-environment-restart-source",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const firstDeployment = await store.recordDeployment({
      projectId: firstProject.id,
      sourceRevisionId: firstRevision.id,
      imageTag: "shared:first",
      containerName: "shared-first",
      internalPort: 3000,
      hostPort: 42001,
      runtimeKind: "docker",
    });
    const secondDeployment = await store.recordDeployment({
      projectId: firstProject.id,
      sourceRevisionId: firstRevision.id,
      imageTag: "shared:second",
      containerName: "shared-second",
      internalPort: 3000,
      hostPort: 42002,
      runtimeKind: "docker",
    });
    const secondProject = await store.createProject({ name: "Other Shared Environment Agent", importKind: "zip" });
    const secondRevision = await store.recordSourceRevision({
      projectId: secondProject.id,
      kind: "zip",
      sourcePath: "/tmp/other-shared-environment-source",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const otherLiveDeployment = await store.recordDeployment({
      projectId: secondProject.id,
      sourceRevisionId: secondRevision.id,
      imageTag: "shared:other-live",
      containerName: "shared-other-live",
      internalPort: 3000,
      hostPort: 42003,
      runtimeKind: "docker",
    });
    const stoppedDeployment = await store.recordDeployment({
      projectId: secondProject.id,
      sourceRevisionId: secondRevision.id,
      imageTag: "shared:stopped",
      containerName: "shared-stopped",
      internalPort: 3000,
      hostPort: 42004,
      runtimeKind: "docker",
    });
    await store.updateDeploymentStatus(stoppedDeployment.id, "stopped");

    const savedResponse = await app.request("/platform/shared-agent-environment", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries: [{ key: "OPENAI_API_KEY", kind: "secret", value: "shared-key" }] }),
    });
    expect(savedResponse.status).toBe(200);
    const saved = await savedResponse.json() as { jobs: Array<{ payload: { deploymentId: string; reason: string } }> };
    expect(saved.jobs.map((job) => job.payload.deploymentId).sort()).toEqual([
      firstDeployment.id,
      secondDeployment.id,
      otherLiveDeployment.id,
    ].sort());
    expect(saved.jobs.every((job) => job.payload.reason === "shared_agent_environment_changed")).toBe(true);

    const unchangedResponse = await app.request("/platform/shared-agent-environment", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries: [{ key: "OPENAI_API_KEY", kind: "secret" }] }),
    });
    expect(unchangedResponse.status).toBe(200);
    await expect(unchangedResponse.json()).resolves.toMatchObject({ jobs: [] });

    const rotatedResponse = await app.request("/platform/shared-agent-environment", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries: [{ key: "OPENAI_API_KEY", kind: "secret", value: "shared-key-v2" }] }),
    });
    expect(rotatedResponse.status).toBe(200);
    const rotated = await rotatedResponse.json() as { jobs: Array<{ payload: { deploymentId: string; reason: string } }> };
    expect(rotated.jobs.map((job) => job.payload.deploymentId).sort()).toEqual([
      firstDeployment.id,
      secondDeployment.id,
      otherLiveDeployment.id,
    ].sort());
    expect(rotated.jobs.every((job) => job.payload.reason === "shared_agent_environment_changed")).toBe(true);
  });

  test("does not expose Project or Deployment binding endpoints", async () => {
    const store = createTestStore();
    const app = createApp(store, { appSecretKey });
    const project = await store.createProject({ name: "Global Shared Environment Agent", importKind: "zip" });

    const responses = await Promise.all([
      app.request(`/projects/${project.id}/shared-agent-environment-bindings`),
      app.request(`/projects/${project.id}/shared-agent-environment-bindings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deploymentId: null }),
      }),
      app.request(`/projects/${project.id}/shared-agent-environment-bindings/binding`, {
        method: "DELETE",
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([404, 404, 404]);
  });
});
