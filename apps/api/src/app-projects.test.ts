import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { decryptSecretValue, type EncryptedSecret } from "@evelandhq/core/server/secrets";
import { createApp } from "./app.js";
import { createTestStore } from "@evelandhq/db/vitest";

import {
  createScheduleRunFixture,
  createSymlinkZipArchiveFixture,
  createZipArchiveFixture,
} from "./app.test-support.js";

describe("api app", () => {
  test("includes the next scheduled run in project list summaries", async () => {
    const store = createTestStore();
    const { project, schedule } = await createScheduleRunFixture(store, false);
    const persistedSchedule = await store.getProjectSchedule(schedule.id);

    const response = await createApp(store).request("/api/projects");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      projects: [
        expect.objectContaining({
          id: project.id,
          nextScheduleAt: persistedSchedule?.nextRunAt,
        }),
      ],
    });
  });

  test("includes the current Eve version status in project list summaries", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Version Summary Agent",
      importKind: "zip",
    });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/version-summary-agent",
      summary: { eveVersion: "0.47.7" },
      envVars: [],
      files: [],
      schedules: [],
    });

    const response = await createApp(store).request("/api/projects");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      projects: [
        expect.objectContaining({
          id: project.id,
          eveVersion: {
            version: "0.47.7",
            expected: "0.47.x or 0.49.x",
            supportedRanges: ["0.47.x", "0.49.x"],
            supported: true,
            sourceRevisionId: revision.id,
          },
        }),
      ],
    });
  });

  test("derives a Git project name, reports availability, and rejects an exact-name conflict", async () => {
    const store = createTestStore();
    const app = createApp(store);

    const availableResponse = await app.request(
      "/api/projects/name-availability?name=sample-office-assistant",
    );
    expect(availableResponse.status).toBe(200);
    await expect(availableResponse.json()).resolves.toEqual({
      available: true,
    });

    const createResponse = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        importKind: "git",
        gitUrl: "https://github.com/evelandhq/sample-office-assistant.git",
        deployAfterImport: true,
      }),
    });

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    expect(created.project).toMatchObject({
      name: "sample-office-assistant",
      slug: "sample-office-assistant",
      importKind: "git",
      status: "import_pending",
    });
    const unavailableResponse = await app.request(
      "/api/projects/name-availability?name=sample-office-assistant",
    );
    await expect(unavailableResponse.json()).resolves.toEqual({
      available: false,
    });

    const duplicateResponse = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        importKind: "git",
        gitUrl: "https://github.com/evelandhq/sample-office-assistant.git",
      }),
    });
    expect(duplicateResponse.status).toBe(409);
    await expect(duplicateResponse.json()).resolves.toEqual({
      error: "Project name is already in use.",
    });

    await expect(store.claimNextJob("new-project-test-worker")).resolves.toMatchObject({
      type: "import_source",
      payload: { deployAfterImport: true },
    });

    const listResponse = await app.request("/api/projects");
    await expect(listResponse.json()).resolves.toMatchObject({
      projects: expect.arrayContaining([
        expect.objectContaining({
          id: created.project.id,
          name: "sample-office-assistant",
        }),
      ]),
    });
  });

  test("updates project display metadata without changing its stable identifiers", async () => {
    const store = createTestStore();
    const app = createApp(store);
    const project = await store.createProject({
      name: "office-assistant",
      importKind: "zip",
    });

    const response = await app.request(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Office Assistant",
        description:
          "Answers routine office questions and helps employees complete common requests.",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      project: {
        id: project.id,
        slug: "office-assistant",
        name: "Office Assistant",
        description:
          "Answers routine office questions and helps employees complete common requests.",
      },
    });
    await expect(store.getProject(project.id)).resolves.toMatchObject({
      id: project.id,
      slug: "office-assistant",
      name: "Office Assistant",
      description: "Answers routine office questions and helps employees complete common requests.",
    });
  });

  test("validates project display metadata and normalizes an empty description", async () => {
    const store = createTestStore();
    const app = createApp(store);
    const project = await store.createProject({
      name: "metadata-validation",
      importKind: "zip",
    });

    const invalidResponse = await app.request(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: " ", description: "x".repeat(241) }),
    });
    expect(invalidResponse.status).toBe(400);

    const clearedResponse = await app.request(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Metadata validation",
        description: "   ",
      }),
    });
    expect(clearedResponse.status).toBe(200);
    await expect(clearedResponse.json()).resolves.toMatchObject({
      project: {
        id: project.id,
        name: "Metadata validation",
        description: null,
      },
    });
  });

  test("preflights source before atomically creating a Project from the validated snapshot", async () => {
    const store = createTestStore();
    const app = createApp(store, {
      appSecretKey: "eveland-test-secret-key-00000000",
    });

    const queuedResponse = await app.request("/api/source-preflights", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "git",
        gitUrl: "https://gitlab.example.com/team/validated-agent.git",
        gitlabPat: "glpat-preflight-only",
      }),
    });
    expect(queuedResponse.status).toBe(202);
    const queued = (await queuedResponse.json()) as {
      preflight: { id: string; status: string };
    };
    expect(queued.preflight).toMatchObject({ status: "queued", kind: "git" });
    expect(JSON.stringify(queued)).not.toContain("glpat-preflight-only");
    await expect(store.listProjects()).resolves.toEqual([]);

    const claimed = await store.claimNextSourcePreflight("api-test-worker");
    expect(claimed?.gitCredential?.encryptedToken).not.toContain("glpat-preflight-only");
    await store.completeSourcePreflight(queued.preflight.id, claimed!.attempts, {
      sourcePath: "/data/preflights/source",
      commitSha: "abc123",
      summary: { eveVersion: "0.47.7", layout: "single-agent" },
    });

    const statusResponse = await app.request(`/api/source-preflights/${queued.preflight.id}`);
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toEqual({
      preflight: expect.objectContaining({
        id: queued.preflight.id,
        status: "completed",
        summary: { eveVersion: "0.47.7", layout: "single-agent" },
      }),
    });

    const projectResponse = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "validated-agent",
        preflightId: queued.preflight.id,
        deployAfterImport: true,
        environmentVariables: [
          { key: "OPENAI_API_KEY", kind: "secret", value: "sk-first-deploy" },
          { key: "MODEL_NAME", kind: "variable", value: "gpt-5" },
        ],
      }),
    });
    expect(projectResponse.status).toBe(201);
    const created = (await projectResponse.json()) as {
      project: { id: string; name: string };
    };
    expect(created.project.name).toBe("validated-agent");
    const secretRecords = await store.listSecretRecords(created.project.id);
    expect(secretRecords.map((secret) => secret.key)).toEqual(["OPENAI_API_KEY", "MODEL_NAME"]);
    expect(secretRecords.map((secret) => secret.kind)).toEqual(["secret", "variable"]);
    expect(
      secretRecords.map((secret) =>
        decryptSecretValue(
          JSON.parse(secret.encryptedValue) as EncryptedSecret,
          "eveland-test-secret-key-00000000",
        ),
      ),
    ).toEqual(["sk-first-deploy", "gpt-5"]);
    await expect(store.listProjectJobs(created.project.id)).resolves.toEqual([
      expect.objectContaining({
        type: "import_source",
        payload: expect.objectContaining({
          sourcePath: "/data/preflights/source",
          deployAfterImport: true,
          gitCredential: expect.objectContaining({ persistAfterImport: true }),
        }),
      }),
    ]);
  });

  test("rejects duplicate initial environment variable keys before consuming a source preflight", async () => {
    const store = createTestStore();
    const app = createApp(store);

    const response = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "duplicate-environment",
        preflightId: "pre_duplicateEnvironment",
        environmentVariables: [
          { key: "OPENAI_API_KEY", value: "first" },
          { key: "OPENAI_API_KEY", value: "second" },
        ],
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid project input",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: ["environmentVariables", 1, "key"],
          message: "Environment variable keys must be unique.",
        }),
      ]),
    });
    await expect(store.listProjects()).resolves.toEqual([]);
  });

  test("encrypts a supplied GitLab PAT for the import job without saving it before import succeeds", async () => {
    const store = createTestStore();
    const app = createApp(store, {
      appSecretKey: "eveland-test-secret-key-00000000",
    });

    const response = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "private-agent",
        importKind: "git",
        gitUrl: "https://GitLab.Example.com/group/private-agent.git",
        gitlabPat: "glpat-first-import-secret",
      }),
    });

    expect(response.status).toBe(201);
    const job = await store.claimNextJob("test-worker");
    expect(job?.payload).toMatchObject({
      gitCredential: {
        userId: "user_local_admin",
        host: "gitlab.example.com",
        persistAfterImport: true,
        encryptedToken: expect.any(String),
      },
    });
    expect(JSON.stringify(job?.payload)).not.toContain("glpat-first-import-secret");
    await expect(
      store.getGitCredential("user_local_admin", "gitlab.example.com"),
    ).resolves.toBeNull();
  });

  test("reuses the current user's saved GitLab PAT for another repository on the same host", async () => {
    const store = createTestStore();
    await store.upsertGitCredential(
      "user_local_admin",
      "gitlab.example.com:8443",
      "saved-encrypted-token",
    );
    const app = createApp(store);

    const response = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "reused-agent",
        importKind: "git",
        gitUrl: "https://gitlab.example.com:8443/group/reused-agent.git",
      }),
    });

    expect(response.status).toBe(201);
    await expect(store.claimNextJob("test-worker")).resolves.toMatchObject({
      payload: {
        gitCredential: {
          userId: "user_local_admin",
          host: "gitlab.example.com:8443",
          encryptedToken: "saved-encrypted-token",
          persistAfterImport: false,
        },
        gitUrl: "https://gitlab.example.com:8443/group/reused-agent.git",
        importKind: "git",
        sourcePath: null,
      },
    });
  });

  test("lists and removes only the current user's saved Git credentials without returning tokens", async () => {
    const store = createTestStore();
    const credential = await store.upsertGitCredential(
      "user_local_admin",
      "gitlab.example.com",
      "encrypted-token",
    );
    await store.upsertGitCredential("another_user", "gitlab.example.com", "other-token");
    const app = createApp(store);

    const list = await app.request("/api/git-credentials");
    expect(list.status).toBe(200);
    const listed = await list.json();
    expect(listed).toEqual({
      credentials: [
        expect.objectContaining({
          id: credential.id,
          host: "gitlab.example.com",
        }),
      ],
    });
    expect(JSON.stringify(listed)).not.toContain("user_local_admin");
    expect(JSON.stringify(listed)).not.toContain("encrypted-token");
    const deleted = await app.request(`/api/git-credentials/${credential.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);
    await expect(
      store.getGitCredential("user_local_admin", "gitlab.example.com"),
    ).resolves.toBeNull();
    await expect(
      store.getGitCredential("another_user", "gitlab.example.com"),
    ).resolves.not.toBeNull();
  });

  test("manually saves a Git credential, normalizing the host and never echoing the PAT", async () => {
    const store = createTestStore();
    const app = createApp(store, {
      appSecretKey: "eveland-test-secret-key-00000000",
    });

    const rejected = await app.request("/api/git-credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host: "gitlab.example.com/group", gitlabPat: "glpat-manual" }),
    });
    expect(rejected.status).toBe(400);

    const created = await app.request("/api/git-credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host: "https://GitLab.Example.COM:8443", gitlabPat: "glpat-manual" }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { credential: { id: string; host: string } };
    expect(createdBody.credential.host).toBe("gitlab.example.com:8443");
    expect(JSON.stringify(createdBody)).not.toContain("glpat-manual");
    expect(JSON.stringify(createdBody)).not.toContain("user_local_admin");

    const stored = await store.getGitCredential("user_local_admin", "gitlab.example.com:8443");
    expect(
      decryptSecretValue(
        JSON.parse(stored!.encryptedToken) as EncryptedSecret,
        "eveland-test-secret-key-00000000",
      ),
    ).toBe("glpat-manual");

    const replaced = await app.request("/api/git-credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host: "gitlab.example.com:8443", gitlabPat: "glpat-rotated" }),
    });
    expect(replaced.status).toBe(201);
    const replacedBody = (await replaced.json()) as { credential: { id: string } };
    expect(replacedBody.credential.id).toBe(createdBody.credential.id);
    await expect(store.listGitCredentials("user_local_admin")).resolves.toHaveLength(1);
    const rotated = await store.getGitCredential("user_local_admin", "gitlab.example.com:8443");
    expect(
      decryptSecretValue(
        JSON.parse(rotated!.encryptedToken) as EncryptedSecret,
        "eveland-test-secret-key-00000000",
      ),
    ).toBe("glpat-rotated");
  });

  test("rejects a manually edited project name that is not already URL-friendly", async () => {
    const response = await createApp(createTestStore()).request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Sample_Office Assistant",
        importKind: "git",
        gitUrl: "https://github.com/evelandhq/sample-office-assistant.git",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid project input",
    });
  });

  test("returns stable and immutable preview Agent endpoints without exposing a raw port", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Endpoint Agent",
      importKind: "zip",
    });
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
      imageTag: "endpoint",
      containerName: "endpoint",
      internalPort: 3000,
      hostPort: 41000,
      runtimeKind: "docker",
    });
    await store.ensureDeploymentRoutes(project.id, deployment.id, "agent.localhost");

    const response = await createApp(store).request(`/api/projects/${project.id}/endpoints`);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      stable: `http://${project.slug}.agent.localhost:17300`,
      previews: [`http://${deployment.deploymentKey}--${project.slug}.agent.localhost:17300`],
    });
    expect(JSON.stringify(body)).not.toContain("41000");
  });

  test("orders preview endpoints oldest-first by deployment and drops archived ones", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Preview Order Agent",
      importKind: "zip",
    });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/source",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deploymentKeys: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const deployment = await store.recordDeployment({
        projectId: project.id,
        sourceRevisionId: revision.id,
        imageTag: `preview-order-${index}`,
        containerName: `preview-order-${index}`,
        internalPort: 3000,
        hostPort: 41000 + index,
        runtimeKind: "docker",
      });
      await store.ensureDeploymentRoutes(project.id, deployment.id, "agent.localhost");
      deploymentKeys.push(deployment.deploymentKey);
    }
    const deployed = await store.listDeployments(project.id);
    const newest = deployed[0]!;
    const archived = deployed[2]!;
    await store.updateDeploymentStatus(archived.id, "archived");

    const response = await createApp(store).request(`/api/projects/${project.id}/endpoints`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { previews: string[] };
    expect(body.previews).toEqual(
      deploymentKeys
        .filter((key) => key !== archived.deploymentKey)
        .map((key) => `http://${key}--${project.slug}.agent.localhost:17300`),
    );
    expect(body.previews.at(-1)).toBe(
      `http://${newest.deploymentKey}--${project.slug}.agent.localhost:17300`,
    );
  });

  test("atomically promotes, rolls traffic weights, creates aliases, and invalidates Gateway cache", async () => {
    const store = createTestStore();
    const invalidated: string[][] = [];
    const project = await store.createProject({
      name: "Traffic Agent",
      importKind: "zip",
    });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/traffic",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const first = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "a",
      containerName: "a",
      internalPort: 3000,
      hostPort: 41001,
      runtimeKind: "docker",
    });
    await store.ensureDeploymentRoutes(project.id, first.id, "agent.localhost");
    const second = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "b",
      containerName: "b",
      internalPort: 3000,
      hostPort: 41002,
      runtimeKind: "docker",
    });
    await store.ensureDeploymentRoutes(project.id, second.id, "agent.localhost");
    const app = createApp(store, {
      invalidateGatewayRoutes: async (hostnames) => {
        invalidated.push(hostnames);
      },
    });
    const stable = await store.findProjectRoute(project.id);
    const preview = (await store.listProjectRoutes(project.id)).find(
      (route) => route.kind === "deployment" && route.targets[0]?.deploymentId === first.id,
    );
    const mutatePreview = await app.request(
      `/api/projects/${project.id}/routes/${preview!.id}/targets`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targets: [{ deploymentId: second.id, weight: 10_000, variantName: "mutable" }],
        }),
      },
    );
    expect(mutatePreview.status).toBe(409);

    const split = await app.request(`/api/projects/${project.id}/routes/${stable!.id}/targets`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targets: [
          { deploymentId: first.id, weight: 9_000, variantName: "control" },
          {
            deploymentId: second.id,
            weight: 1_000,
            variantName: "candidate",
          },
        ],
      }),
    });
    expect(split.status).toBe(200);
    await expect(split.json()).resolves.toMatchObject({
      route: { policyRevision: 2 },
    });

    const promote = await app.request(
      `/api/projects/${project.id}/deployments/${second.id}/promote`,
      {
        method: "POST",
      },
    );
    expect(promote.status).toBe(200);
    await expect(store.getCurrentDeployment(project.id)).resolves.toMatchObject({ id: second.id });
    const alias = await app.request(`/api/projects/${project.id}/aliases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        alias: "canary",
        targets: [{ deploymentId: second.id, weight: 10_000, variantName: "canary" }],
      }),
    });
    expect(alias.status).toBe(201);
    expect(invalidated.flat()).toEqual(
      expect.arrayContaining([
        `${project.slug}.agent.localhost`,
        `canary--${project.slug}.agent.localhost`,
      ]),
    );
  });

  test("drains a zero-weight deployment without treating its immutable preview as mutable traffic", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Drain Agent",
      importKind: "zip",
    });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/drain",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const first = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "drain-a",
      containerName: "drain-a",
      internalPort: 3000,
      hostPort: 41201,
      runtimeKind: "docker",
    });
    await store.ensureDeploymentRoutes(project.id, first.id, "agent.localhost");
    const second = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "drain-b",
      containerName: "drain-b",
      internalPort: 3000,
      hostPort: 41202,
      runtimeKind: "docker",
    });
    await store.ensureDeploymentRoutes(project.id, second.id, "agent.localhost");
    const stable = await store.findProjectRoute(project.id);
    await store.updateRouteTargets(stable!.id, [
      { deploymentId: first.id, weight: 0, variantName: "control" },
      { deploymentId: second.id, weight: 10_000, variantName: "candidate" },
    ]);

    const response = await createApp(store).request(
      `/api/projects/${project.id}/deployments/${first.id}/drain`,
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      deployment: { id: first.id, status: "draining" },
    });
    await expect(
      store.findRouteByHostname(`${first.deploymentKey}--${project.slug}.agent.localhost`),
    ).resolves.toMatchObject({
      kind: "deployment",
      targets: [
        expect.objectContaining({
          deploymentId: first.id,
          weight: 10_000,
          status: "draining",
        }),
      ],
    });
  });

  test("reports an expired Playground binding as eligible for archive", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Expired Retention Agent",
      importKind: "zip",
    });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/expired-retention",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployments = [];
    for (let index = 0; index < 4; index += 1) {
      deployments.push(
        await store.recordDeployment({
          projectId: project.id,
          sourceRevisionId: revision.id,
          imageTag: `expired-retention-${index}`,
          summary:
            index === 0 ? { summarySource: "build-manifest", eveVersionResolved: "0.47.7" } : null,
          containerName: `expired-retention-${index}`,
          internalPort: 3000,
          hostPort: 41210 + index,
          runtimeKind: "docker",
        }),
      );
    }
    const [stableRoute] = await store.ensureDeploymentRoutes(
      project.id,
      deployments[3]!.id,
      "agent.localhost",
    );
    await store.bindSession({
      projectId: project.id,
      eveSessionId: "eve_expired_retention",
      routeId: stableRoute!.id,
      deploymentId: deployments[0]!.id,
      trigger: "playground",
      variantName: null,
      experimentId: null,
      requestId: "request_expired_retention",
      remoteIp: null,
      affinityFingerprint: null,
      affinitySource: null,
    });
    const app = createApp(store, {
      // Relative to the binding's real bind time: a fixed calendar date here
      // silently stops exceeding playgroundSessionIdleTtlMs once the wall
      // clock catches up to it, turning this test into a time bomb.
      sessionBindingNow: () => new Date(Date.now() + 2 * 86_400_000),
      playgroundSessionIdleTtlMs: 86_400_000,
      apiSessionIdleTtlMs: 604_800_000,
    });

    const response = await app.request(`/api/projects/${project.id}/deployments`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      retention: expect.arrayContaining([
        expect.objectContaining({
          deployment: expect.objectContaining({ id: deployments[0]!.id }),
          protected: false,
          reasons: [],
        }),
      ]),
      // Each release's build-derived summary is part of the read model; a
      // release built without one reports null rather than disappearing.
      releaseSummaries: expect.objectContaining({
        [deployments[0]!.releaseId]: expect.objectContaining({
          summarySource: "build-manifest",
          eveVersionResolved: "0.47.7",
        }),
        [deployments[1]!.releaseId]: null,
      }),
    });
  });

  test("groups experiment metrics by deployment, experiment, and variant", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Metrics Agent",
      importKind: "zip",
    });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/metrics",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const control = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "control",
      containerName: "control",
      internalPort: 3000,
      hostPort: 41301,
      runtimeKind: "docker",
    });
    await store.ensureDeploymentRoutes(project.id, control.id, "agent.localhost");
    const candidate = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "candidate",
      containerName: "candidate",
      internalPort: 3000,
      hostPort: 41302,
      runtimeKind: "docker",
    });
    await store.ensureDeploymentRoutes(project.id, candidate.id, "agent.localhost");
    const stable = await store.findProjectRoute(project.id);
    await store.updateRouteTargets(stable!.id, [
      { deploymentId: control.id, weight: 5_000, variantName: "control" },
      { deploymentId: candidate.id, weight: 5_000, variantName: "candidate" },
    ]);
    const experimentId = `${stable!.id}:r2`;

    const controlSession = await store.createSession({
      projectId: project.id,
      deploymentId: control.id,
      eveSessionId: "eve_control",
      trigger: "api",
    });
    await store.bindSession({
      projectId: project.id,
      eveSessionId: "eve_control",
      routeId: stable!.id,
      deploymentId: control.id,
      trigger: "api",
      variantName: "control",
      experimentId,
      requestId: "req_control",
      remoteIp: null,
      affinityFingerprint: "sha256-control",
      affinitySource: "version_key",
    });
    await store.recordModelUsage(controlSession.id, {
      eveSessionId: "eve_control",
      turnId: "turn_control",
      stepIndex: 0,
      finishReason: "stop",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      costUsd: 0.01,
      usageReported: true,
    });
    await store.completeSession(controlSession.id, { status: "completed" });

    const candidateSession = await store.createSession({
      projectId: project.id,
      deploymentId: candidate.id,
      eveSessionId: "eve_candidate",
      trigger: "api",
    });
    await store.bindSession({
      projectId: project.id,
      eveSessionId: "eve_candidate",
      routeId: stable!.id,
      deploymentId: candidate.id,
      trigger: "api",
      variantName: "candidate",
      experimentId,
      requestId: "req_candidate",
      remoteIp: null,
      affinityFingerprint: "sha256-candidate",
      affinitySource: "version_key",
    });
    await store.recordModelUsage(candidateSession.id, {
      eveSessionId: "eve_candidate",
      turnId: "turn_candidate",
      stepIndex: 0,
      finishReason: "error",
      inputTokens: 20,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.02,
      usageReported: true,
    });
    await store.completeSession(candidateSession.id, { status: "failed" });

    const response = await createApp(store).request(`/api/projects/${project.id}/variant-metrics`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      variants: expect.arrayContaining([
        expect.objectContaining({
          deploymentId: control.id,
          experimentId,
          variantName: "control",
          sessions: 1,
          success: 1,
          failure: 0,
          tokens: 18,
          costUsd: 0.01,
          averageLatencyMs: expect.any(Number),
        }),
        expect.objectContaining({
          deploymentId: candidate.id,
          experimentId,
          variantName: "candidate",
          sessions: 1,
          success: 0,
          failure: 1,
          tokens: 22,
          costUsd: 0.02,
          averageLatencyMs: expect.any(Number),
        }),
      ]),
    });
  });

  test("creates a zip project from an uploaded archive and stores the extracted source path", async () => {
    const store = createTestStore();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "eveland-api-data-"));
    const archivePath = await createZipArchiveFixture();
    const archive = new File([await readFile(archivePath)], "agent.zip", {
      type: "application/zip",
    });
    const form = new FormData();
    form.set("name", "zip-agent");
    form.set("archive", archive);
    const app = createApp(store, { dataDir });

    const response = await app.request("/api/projects", {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      project: expect.objectContaining({
        name: "zip-agent",
        importKind: "zip",
        status: "import_pending",
      }),
    });
    const job = await store.claimNextJob("test-worker");
    if (job?.type !== "import_source") {
      throw new Error("Expected a source import job.");
    }
    const sourcePath = job.payload.sourcePath;
    expect(sourcePath).toEqual(expect.stringContaining(path.join(dataDir, "uploads")));
    await expect(
      readFile(path.join(String(sourcePath), "agent", "instructions.md"), "utf8"),
    ).resolves.toBe("You are a helpful test agent.");
  });

  test("queues a Zip source preflight without creating a Project", async () => {
    const store = createTestStore();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "eveland-api-preflight-"));
    const archivePath = await createZipArchiveFixture({
      wrappedDirectory: "validated",
    });
    const archive = new File([await readFile(archivePath)], "validated.zip", {
      type: "application/zip",
    });
    const form = new FormData();
    form.set("archive", archive);

    const response = await createApp(store, { dataDir }).request("/api/source-preflights", {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(202);
    await expect(store.listProjects()).resolves.toEqual([]);
    const claimed = await store.claimNextSourcePreflight("zip-preflight-worker");
    expect(claimed).toMatchObject({ kind: "zip", status: "running" });
    await expect(
      readFile(path.join(claimed!.sourcePath!, "agent", "instructions.md"), "utf8"),
    ).resolves.toBe("You are a helpful test agent.");
    await rm(dataDir, { recursive: true, force: true });
  });

  test("uses the only top-level directory in a zip archive as the source root", async () => {
    const store = createTestStore();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "eveland-api-data-"));
    const archivePath = await createZipArchiveFixture({
      wrappedDirectory: "helloworld",
    });
    const archive = new File([await readFile(archivePath)], "helloworld.zip", {
      type: "application/zip",
    });
    const form = new FormData();
    form.set("name", "wrapped-zip-agent");
    form.set("archive", archive);
    const app = createApp(store, { dataDir });

    const response = await app.request("/api/projects", {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(201);
    const job = await store.claimNextJob("test-worker");
    if (job?.type !== "import_source") {
      throw new Error("Expected a source import job.");
    }
    const sourcePath = String(job.payload.sourcePath);
    await expect(readFile(path.join(sourcePath, "agent", "instructions.md"), "utf8")).resolves.toBe(
      "You are a helpful test agent.",
    );
    expect(sourcePath.endsWith(`${path.sep}helloworld`)).toBe(true);
  });

  test("returns the URL-friendly name rule for an invalid Zip project name", async () => {
    const archive = new File(["not inspected before validation"], "agent.zip", {
      type: "application/zip",
    });
    const form = new FormData();
    form.set("name", "Zip Agent");
    form.set("archive", archive);

    const response = await createApp(createTestStore()).request("/api/projects", {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      issues: [
        expect.objectContaining({
          path: ["name"],
          message: expect.stringMatching(/lowercase letters/i),
        }),
      ],
    });
  });
});

describe("zip upload hardening", () => {
  test("rejects a zip containing a symlink entry with 400 and cleans up the upload dir", async () => {
    const store = createTestStore();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "eveland-api-data-"));
    const archivePath = await createSymlinkZipArchiveFixture();
    const archive = new File([await readFile(archivePath)], "evil.zip", {
      type: "application/zip",
    });
    const form = new FormData();
    form.set("name", "evil-agent");
    form.set("archive", archive);
    const app = createApp(store, { dataDir });

    const response = await app.request("/api/projects", { method: "POST", body: form });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid zip upload",
      issues: [expect.objectContaining({ message: expect.stringContaining("symbolic links") })],
    });
    // The rejected upload leaves nothing behind for later steps to trip on.
    const uploads = await readdir(path.join(dataDir, "uploads")).catch(() => []);
    expect(uploads).toEqual([]);
  });

  test("rejects a symlink zip on the source-preflight path too", async () => {
    const store = createTestStore();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "eveland-api-data-"));
    const archivePath = await createSymlinkZipArchiveFixture();
    const archive = new File([await readFile(archivePath)], "evil.zip", {
      type: "application/zip",
    });
    const form = new FormData();
    form.set("archive", archive);
    const app = createApp(store, { dataDir });

    const response = await app.request("/api/source-preflights", { method: "POST", body: form });

    expect(response.status).toBe(400);
  });

  test("rejects an upload above EVELAND_MAX_UPLOAD_BYTES with 413", async () => {
    const previous = process.env.EVELAND_MAX_UPLOAD_BYTES;
    process.env.EVELAND_MAX_UPLOAD_BYTES = "512";
    try {
      const store = createTestStore();
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "eveland-api-data-"));
      const archivePath = await createZipArchiveFixture();
      const archive = new File([await readFile(archivePath)], "agent.zip", {
        type: "application/zip",
      });
      const form = new FormData();
      form.set("name", "big-agent");
      form.set("archive", archive);
      const app = createApp(store, { dataDir });

      const response = await app.request("/api/projects", { method: "POST", body: form });

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({ error: "Upload too large" });
    } finally {
      if (previous === undefined) delete process.env.EVELAND_MAX_UPLOAD_BYTES;
      else process.env.EVELAND_MAX_UPLOAD_BYTES = previous;
    }
  });
});

describe("promote failure handling", () => {
  async function promotableFixture() {
    const store = createTestStore();
    const project = await store.createProject({ name: "Promote Errors Agent", importKind: "zip" });
    const importJob = await store.claimNextJob("promote-fixture");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/promote-errors",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "promote-errors:1",
      containerName: "promote-errors-1",
      internalPort: 3000,
      hostPort: 41300,
      runtimeKind: "docker",
    });
    await store.ensureDeploymentRoutes(project.id, deployment.id, "agent.localhost");
    return { store, project, deployment };
  }

  test("returns 404 for a deployment that does not belong to the project", async () => {
    const { store, project } = await promotableFixture();
    const app = createApp(store, { invalidateGatewayRoutes: async () => {} });

    const response = await app.request(
      `/api/projects/${project.id}/deployments/dep_missing/promote`,
      {
        method: "POST",
      },
    );

    expect(response.status).toBe(404);
  });

  test("returns 409 for a deployment that is not running", async () => {
    const { store, project, deployment } = await promotableFixture();
    await store.updateDeploymentStatus(deployment.id, "stopped");
    const app = createApp(store, { invalidateGatewayRoutes: async () => {} });

    const response = await app.request(
      `/api/projects/${project.id}/deployments/${deployment.id}/promote`,
      { method: "POST" },
    );

    expect(response.status).toBe(409);
  });

  test("still reports success when Gateway cache invalidation fails after the route change committed", async () => {
    const { store, project, deployment } = await promotableFixture();
    await store.updateDeploymentStatus(deployment.id, "running");
    const app = createApp(store, {
      invalidateGatewayRoutes: async () => {
        throw new Error("Gateway returned 503 while invalidating.");
      },
    });

    const response = await app.request(
      `/api/projects/${project.id}/deployments/${deployment.id}/promote`,
      { method: "POST" },
    );

    // The promote is already committed; answering 500 told the operator it
    // failed while the stable route had in fact moved. Gateway picks the
    // change up at its cache TTL.
    expect(response.status).toBe(200);
    const stable = await store.findProjectRoute(project.id);
    expect(stable!.targets).toEqual([
      expect.objectContaining({ deploymentId: deployment.id, weight: 10_000 }),
    ]);
  });
});
