import { execFile } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test, vi } from "vitest";
import { createBuildInfo } from "@eveland/core/build-info";
import { createScheduleDispatchCredential } from "@eveland/core/server/scheduler-dispatch";
import { createApp } from "./app.js";
import { createMemoryStore, type Store } from "@eveland/db";

const execFileAsync = promisify(execFile);

describe("api app", () => {
  test("creates, renews, and releases a service-authenticated runtime activation", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Wake API Agent", importKind: "zip" });
    const importJob = await store.claimNextJob("fixture-import");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/wake-api-agent",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "fixture:wake-api",
      containerName: "fixture-wake-api",
      internalPort: 3000,
      hostPort: 41991,
      runtimeKind: "docker",
    });
    await store.updateDeploymentStatus(deployment.id, "stopped");
    const app = createApp(store, {
      gatewayServiceToken: "gateway-service-token",
      runtimeActivationWaiter: async (claim) => {
        const ready = await store.updateRuntimeInstance(claim.runtimeInstance.id, {
          status: "ready",
          endpointHost: "127.0.0.1",
          endpointPort: deployment.hostPort,
        });
        if (!ready) throw new Error("missing runtime instance");
        return ready;
      },
    });

    expect((await app.request("/internal/runtime/activations", { method: "POST" })).status).toBe(404);
    const activation = await app.request("/internal/runtime/activations", {
      method: "POST",
      headers: { authorization: "Bearer gateway-service-token", "content-type": "application/json" },
      body: JSON.stringify({ deploymentId: deployment.id, kind: "public_request", ownerId: "req_api_wake" }),
    });
    expect(activation.status).toBe(200);
    const body = await activation.json() as { lease: { id: string }; runtimeInstance: { status: string; endpointPort: number } };
    expect(body.runtimeInstance).toMatchObject({ status: "ready", endpointPort: deployment.hostPort });
    await expect(store.claimNextJob("wake-worker")).resolves.toMatchObject({
      type: "ensure_deployment_running",
      payload: { deploymentId: deployment.id, runtimeInstanceId: expect.any(String) },
    });

    const renew = await app.request(`/internal/runtime/activations/${body.lease.id}/renew`, {
      method: "POST",
      headers: { authorization: "Bearer gateway-service-token" },
    });
    expect(renew.status).toBe(200);
    const release = await app.request(`/internal/runtime/activations/${body.lease.id}`, {
      method: "DELETE",
      headers: { authorization: "Bearer gateway-service-token" },
    });
    expect(release.status).toBe(204);
    await expect(store.getActivationLease(body.lease.id)).resolves.toMatchObject({ releasedAt: expect.any(String) });
  });

  test("releases only the request lease when a cold activation is aborted", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Aborted Wake API Agent", importKind: "zip" });
    const importJob = await store.claimNextJob("fixture-import");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/aborted-wake-api-agent",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "fixture:aborted-wake-api",
      containerName: "fixture-aborted-wake-api",
      internalPort: 3000,
      hostPort: 41992,
      runtimeKind: "docker",
    });
    await store.updateDeploymentStatus(deployment.id, "stopped");
    let waiterStarted!: () => void;
    const started = new Promise<void>((resolve) => { waiterStarted = resolve; });
    let abortedLeaseId: string | null = null;
    const app = createApp(store, {
      gatewayServiceToken: "gateway-service-token",
      runtimeActivationWaiter: async (claim, input) => {
        abortedLeaseId = claim.lease.id;
        waiterStarted();
        return new Promise<never>((_resolve, reject) => {
          input.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      },
    });
    const controller = new AbortController();
    const pending = app.request("/internal/runtime/activations", {
      method: "POST",
      headers: { authorization: "Bearer gateway-service-token", "content-type": "application/json" },
      body: JSON.stringify({ deploymentId: deployment.id, kind: "public_request", ownerId: "req_api_aborted" }),
      signal: controller.signal,
    });
    await started;
    controller.abort();

    expect((await pending).status).toBe(499);
    expect(abortedLeaseId).not.toBeNull();
    await expect(store.getActivationLease(abortedLeaseId!)).resolves.toMatchObject({ releasedAt: expect.any(String) });
  });

  test("redeems a schedule dispatch credential once and attaches completed Sessions", async () => {
    const store = createMemoryStore();
    const { project, schedule, deployment, run } = await createScheduleRunFixture(store);
    await store.claimScheduleRunActivation(run.id);
    const dispatchSecret = "schedule-dispatch-secret-at-least-32-bytes";
    const runtimeSecret = "runtime-secret-at-least-32-bytes-long";
    const credential = createScheduleDispatchCredential({
      scheduleRunId: run.id,
      deploymentId: deployment.id,
      scheduleKey: schedule.key,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, dispatchSecret);
    const app = createApp(store, { schedulerDispatchSecret: dispatchSecret, schedulerRuntimeSecret: runtimeSecret });

    const claim = () => app.request("/internal/scheduler/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json", "x-eveland-runtime-secret": runtimeSecret },
      body: JSON.stringify({ phase: "claim", credential, scheduleRunId: run.id, scheduleKey: schedule.key }),
    });
    expect((await claim()).status).toBe(200);
    expect((await claim()).status).toBe(409);

    const complete = await app.request("/internal/scheduler/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json", "x-eveland-runtime-secret": runtimeSecret },
      body: JSON.stringify({
        phase: "complete",
        credential,
        scheduleRunId: run.id,
        scheduleKey: schedule.key,
        sessionIds: ["eve_schedule_api"],
        status: "succeeded",
      }),
    });
    expect(complete.status).toBe(200);
    await expect(store.getScheduleRun(run.id)).resolves.toMatchObject({ status: "succeeded" });
    await expect(store.listSessions(project.id)).resolves.toContainEqual(expect.objectContaining({
      eveSessionId: "eve_schedule_api",
      scheduleRunId: run.id,
    }));
  });

  test("creates a manual ScheduleRun through the control-plane path", async () => {
    const store = createMemoryStore();
    const { project, schedule, deployment } = await createScheduleRunFixture(store, false);
    const response = await createApp(store).request(`/projects/${project.id}/schedules/${schedule.id}/runs`, { method: "POST" });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ run: {
      scheduleId: schedule.id,
      deploymentId: deployment.id,
      trigger: "manual",
      status: "queued",
    } });
  });

  test("returns health status", async () => {
    const buildInfo = createBuildInfo("api", {
      revision: "6bb1d53f51ab",
      channel: "stable",
    });
    const app = createApp(createMemoryStore(), { buildInfo });
    const response = await app.request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, ...buildInfo });
  });

  test("reports collector degradation separately from API liveness", async () => {
    const app = createApp(createMemoryStore(), {
      collectorHealth: () => ({
        status: "degraded",
        lastProcessedAt: null,
        backlogEvents: 4,
        backlogBytes: 2048,
        oldestEventAge: 30_000,
        quarantinedEvents: 1,
        lastError: "invalid envelope",
      }),
    });

    expect((await app.request("/health")).status).toBe(200);
    const response = await app.request("/internal/collector/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "degraded", backlogEvents: 4 });
  });

  test("derives a Git project name from the repository URL and returns the claimed slug", async () => {
    const app = createApp(createMemoryStore());

    const createResponse = await app.request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        importKind: "git",
        gitUrl: "https://github.com/evelandhq/sample-office-assistant.git",
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

    const duplicateResponse = await app.request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        importKind: "git",
        gitUrl: "https://github.com/evelandhq/sample-office-assistant.git",
      }),
    });
    await expect(duplicateResponse.json()).resolves.toMatchObject({
      project: { name: "sample-office-assistant-1", slug: "sample-office-assistant-1" },
    });

    const listResponse = await app.request("/projects");
    await expect(listResponse.json()).resolves.toMatchObject({
      projects: expect.arrayContaining([
        expect.objectContaining({ id: created.project.id, name: "sample-office-assistant" }),
        expect.objectContaining({ name: "sample-office-assistant-1" }),
      ]),
    });
  });

  test("rejects a manually edited project name that is not already URL-friendly", async () => {
    const response = await createApp(createMemoryStore()).request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Sample_Office Assistant",
        importKind: "git",
        gitUrl: "https://github.com/evelandhq/sample-office-assistant.git",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Invalid project input" });
  });

  test("returns stable and immutable preview Agent endpoints without exposing a raw port", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Endpoint Agent", importKind: "zip" });
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

    const response = await createApp(store).request(`/projects/${project.id}/endpoints`);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      stable: `http://${project.slug}.agent.localhost:4080`,
      previews: [`http://${deployment.deploymentKey}--${project.slug}.agent.localhost:4080`],
    });
    expect(JSON.stringify(body)).not.toContain("41000");
  });

  test("atomically promotes, rolls traffic weights, creates aliases, and invalidates Gateway cache", async () => {
    const store = createMemoryStore();
    const invalidated: string[][] = [];
    const project = await store.createProject({ name: "Traffic Agent", importKind: "zip" });
    const revision = await store.recordSourceRevision({ projectId: project.id, kind: "zip", sourcePath: "/tmp/traffic", summary: {}, envVars: [], files: [], schedules: [] });
    const first = await store.recordDeployment({ projectId: project.id, sourceRevisionId: revision.id, imageTag: "a", containerName: "a", internalPort: 3000, hostPort: 41001, runtimeKind: "docker" });
    await store.ensureDeploymentRoutes(project.id, first.id, "agent.localhost");
    const second = await store.recordDeployment({ projectId: project.id, sourceRevisionId: revision.id, imageTag: "b", containerName: "b", internalPort: 3000, hostPort: 41002, runtimeKind: "docker" });
    await store.ensureDeploymentRoutes(project.id, second.id, "agent.localhost");
    const app = createApp(store, { invalidateGatewayRoutes: async (hostnames) => { invalidated.push(hostnames); } });
    const stable = await store.findProjectRoute(project.id);
    const preview = (await store.listProjectRoutes(project.id)).find(
      (route) => route.kind === "deployment" && route.targets[0]?.deploymentId === first.id,
    );
    const mutatePreview = await app.request(`/projects/${project.id}/routes/${preview!.id}/targets`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targets: [{ deploymentId: second.id, weight: 10_000, variantName: "mutable" }] }),
    });
    expect(mutatePreview.status).toBe(409);

    const split = await app.request(`/projects/${project.id}/routes/${stable!.id}/targets`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ targets: [
        { deploymentId: first.id, weight: 9_000, variantName: "control" },
        { deploymentId: second.id, weight: 1_000, variantName: "candidate" },
      ] }),
    });
    expect(split.status).toBe(200);
    await expect(split.json()).resolves.toMatchObject({ route: { policyRevision: 2 } });

    const promote = await app.request(`/projects/${project.id}/deployments/${second.id}/promote`, { method: "POST" });
    expect(promote.status).toBe(200);
    await expect(store.getCurrentDeployment(project.id)).resolves.toMatchObject({ id: second.id });
    const alias = await app.request(`/projects/${project.id}/aliases`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ alias: "canary", targets: [
        { deploymentId: second.id, weight: 10_000, variantName: "canary" },
      ] }),
    });
    expect(alias.status).toBe(201);
    expect(invalidated.flat()).toEqual(expect.arrayContaining([`${project.slug}.agent.localhost`, `canary--${project.slug}.agent.localhost`]));
  });

  test("drains a zero-weight deployment without treating its immutable preview as mutable traffic", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Drain Agent", importKind: "zip" });
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

    const response = await createApp(store).request(`/projects/${project.id}/deployments/${first.id}/drain`, { method: "POST" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ deployment: { id: first.id, status: "draining" } });
    await expect(store.findRouteByHostname(`${first.deploymentKey}--${project.slug}.agent.localhost`)).resolves.toMatchObject({
      kind: "deployment",
      targets: [expect.objectContaining({ deploymentId: first.id, weight: 10_000, status: "draining" })],
    });
  });

  test("groups experiment metrics by deployment, experiment, and variant", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Metrics Agent", importKind: "zip" });
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
      projectId: project.id, sourceRevisionId: revision.id, imageTag: "control", containerName: "control",
      internalPort: 3000, hostPort: 41301, runtimeKind: "docker",
    });
    await store.ensureDeploymentRoutes(project.id, control.id, "agent.localhost");
    const candidate = await store.recordDeployment({
      projectId: project.id, sourceRevisionId: revision.id, imageTag: "candidate", containerName: "candidate",
      internalPort: 3000, hostPort: 41302, runtimeKind: "docker",
    });
    await store.ensureDeploymentRoutes(project.id, candidate.id, "agent.localhost");
    const stable = await store.findProjectRoute(project.id);
    await store.updateRouteTargets(stable!.id, [
      { deploymentId: control.id, weight: 5_000, variantName: "control" },
      { deploymentId: candidate.id, weight: 5_000, variantName: "candidate" },
    ]);
    const experimentId = `${stable!.id}:r2`;

    const controlSession = await store.createSession({ projectId: project.id, deploymentId: control.id, eveSessionId: "eve_control", trigger: "api" });
    await store.bindSession({
      projectId: project.id, eveSessionId: "eve_control", routeId: stable!.id, deploymentId: control.id,
      trigger: "api", variantName: "control", experimentId, requestId: "req_control", remoteIp: null,
      affinityFingerprint: "sha256-control", affinitySource: "version_key",
    });
    await store.recordModelUsage(controlSession.id, {
      eveSessionId: "eve_control", turnId: "turn_control", stepIndex: 0, finishReason: "stop",
      inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1, costUsd: 0.01, usageReported: true,
    });
    await store.completeSession(controlSession.id, { status: "completed" });

    const candidateSession = await store.createSession({ projectId: project.id, deploymentId: candidate.id, eveSessionId: "eve_candidate", trigger: "api" });
    await store.bindSession({
      projectId: project.id, eveSessionId: "eve_candidate", routeId: stable!.id, deploymentId: candidate.id,
      trigger: "api", variantName: "candidate", experimentId, requestId: "req_candidate", remoteIp: null,
      affinityFingerprint: "sha256-candidate", affinitySource: "version_key",
    });
    await store.recordModelUsage(candidateSession.id, {
      eveSessionId: "eve_candidate", turnId: "turn_candidate", stepIndex: 0, finishReason: "error",
      inputTokens: 20, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.02, usageReported: true,
    });
    await store.completeSession(candidateSession.id, { status: "failed" });

    const response = await createApp(store).request(`/projects/${project.id}/variant-metrics`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ variants: expect.arrayContaining([
      expect.objectContaining({
        deploymentId: control.id, experimentId, variantName: "control", sessions: 1,
        success: 1, failure: 0, tokens: 18, costUsd: 0.01, averageLatencyMs: expect.any(Number),
      }),
      expect.objectContaining({
        deploymentId: candidate.id, experimentId, variantName: "candidate", sessions: 1,
        success: 0, failure: 1, tokens: 22, costUsd: 0.02, averageLatencyMs: expect.any(Number),
      }),
    ]) });
  });

  test("creates a zip project from an uploaded archive and stores the extracted source path", async () => {
    const store = createMemoryStore();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "eveland-api-data-"));
    const archivePath = await createZipArchiveFixture();
    const archive = new File([await readFile(archivePath)], "agent.zip", { type: "application/zip" });
    const form = new FormData();
    form.set("name", "zip-agent");
    form.set("archive", archive);
    const app = createApp(store, { dataDir });

    const response = await app.request("/projects", {
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
    form.set("name", "wrapped-zip-agent");
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

  test("returns the URL-friendly name rule for an invalid Zip project name", async () => {
    const archive = new File(["not inspected before validation"], "agent.zip", { type: "application/zip" });
    const form = new FormData();
    form.set("name", "Zip Agent");
    form.set("archive", archive);

    const response = await createApp(createMemoryStore()).request("/projects", { method: "POST", body: form });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      issues: [expect.objectContaining({ path: ["name"], message: expect.stringMatching(/lowercase letters/i) })],
    });
  });

  test("stores secrets without returning secret values", async () => {
    const app = createApp(createMemoryStore());
    const createProject = await app.request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "secret-agent", importKind: "zip" }),
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

  test("queues a targeted restart for every live deployment after saving a secret", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Secret Refresh Agent", importKind: "zip", sourcePath: "/tmp/source" });
    const importJob = await store.claimNextJob("test-worker");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/source",
      summary: {},
      envVars: ["DEEPSEEK_API_KEY"],
      files: [],
      schedules: [],
    });
    const stable = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "secret-refresh:stable",
      containerName: "secret-refresh-stable",
      internalPort: 3000,
      hostPort: 41040,
      runtimeKind: "docker",
    });
    const preview = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "secret-refresh:preview",
      containerName: "secret-refresh-preview",
      internalPort: 3000,
      hostPort: 41041,
      runtimeKind: "docker",
    });

    const response = await createApp(store).request(`/projects/${project.id}/secrets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "DEEPSEEK_API_KEY", value: "sk-test-deepseek" }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      jobs: expect.arrayContaining([
        expect.objectContaining({
          type: "restart_deployment",
          payload: expect.objectContaining({ deploymentId: stable.id }),
        }),
        expect.objectContaining({
          type: "restart_deployment",
          payload: expect.objectContaining({ deploymentId: preview.id }),
        }),
      ]),
    });
    const queuedDeploymentIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const job = await store.claimNextJob("test-worker");
      expect(job).toMatchObject({ type: "restart_deployment" });
      queuedDeploymentIds.push(String(job!.payload.deploymentId));
      await store.completeJob(job!.id);
    }
    expect(queuedDeploymentIds).toEqual(expect.arrayContaining([stable.id, preview.id]));
  });

  test("queues live deployment secret refreshes only when a secret was deleted", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Secret Delete Agent", importKind: "zip", sourcePath: "/tmp/source" });
    const importJob = await store.claimNextJob("test-worker");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/source",
      summary: {},
      envVars: ["DEEPSEEK_API_KEY"],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "secret-delete:stable",
      containerName: "secret-delete-stable",
      internalPort: 3000,
      hostPort: 41042,
      runtimeKind: "docker",
    });
    const secret = await store.upsertSecret(project.id, "DEEPSEEK_API_KEY", "encrypted-placeholder");
    const app = createApp(store);

    const missing = await app.request(`/projects/${project.id}/secrets/secret_missing`, { method: "DELETE" });
    await expect(missing.json()).resolves.toMatchObject({ deleted: false, jobs: [] });
    await expect(store.claimNextJob("test-worker")).resolves.toBeNull();

    const response = await app.request(`/projects/${project.id}/secrets/${secret.id}`, { method: "DELETE" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      deleted: true,
      jobs: [
        expect.objectContaining({
          type: "restart_deployment",
          payload: expect.objectContaining({ deploymentId: deployment.id }),
        }),
      ],
    });
  });

  test("rejects an invalid secret encryption key when the API starts", () => {
    expect(() =>
      createApp(createMemoryStore(), {
        appSecretKey: "1234567890123456789012345678901",
      }),
    ).toThrow("APP_SECRET_KEY must be 32 bytes or a base64 encoded 32-byte value.");
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
        status: "waiting",
        eveSessionId: "eve_123",
      }),
      events: [
        expect.objectContaining({ type: "message", payload: { role: "user", content: "Hello" } }),
        expect.objectContaining({ type: "model_response", payload: { content: "Hello from deployment" } }),
      ],
    });
    expect(runnerCalls).toEqual([expect.objectContaining({ message: "Hello", deployment: expect.objectContaining({ id: deployment.id }) })]);
    await expect(store.listSessions(project.id)).resolves.toEqual([expect.objectContaining({ trigger: "playground", status: "waiting" })]);
  });

  test("keeps one platform Session across streamed Playground turns and HITL continuation", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Streaming Playground Agent", importKind: "zip" });
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
      imageTag: "eveland/playground:streaming",
      containerName: "eveland-playground-streaming",
      internalPort: 3000,
      hostPort: 41003,
      runtimeKind: "docker",
    });
    const proxyCalls: Array<{ method: string; path: string; body: string }> = [];
    const app = createApp(store, {
      async playgroundProxy(input) {
        const body = input.body ? new TextDecoder().decode(input.body) : "";
        proxyCalls.push({ method: input.method, path: input.path, body });
        if (input.method === "POST" && input.path === "/eve/v1/session") {
          return new Response(JSON.stringify({ sessionId: "eve_chat", continuationToken: "continue_1" }), {
            status: 202,
            headers: { "content-type": "application/json", "x-eve-session-id": "eve_chat" },
          });
        }
        if (input.method === "GET" && input.path === "/eve/v1/session/eve_chat/stream") {
          return new Response(
            [
              { type: "reasoning.appended", data: { reasoningDelta: "Checking", reasoningSoFar: "Checking" } },
              {
                type: "input.requested",
                data: {
                  requests: [
                    {
                      requestId: "request_1",
                      prompt: "Run the tool?",
                      action: { kind: "tool-call", callId: "call_1", toolName: "deploy", input: { target: "preview" } },
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
            ].map((event) => JSON.stringify(event)).join("\n") + "\n",
            { status: 200, headers: { "content-type": "application/x-ndjson" } },
          );
        }
        if (input.method === "POST" && input.path === "/eve/v1/session/eve_chat") {
          return new Response(JSON.stringify({ sessionId: "eve_chat", continuationToken: "continue_2" }), {
            status: 202,
            headers: { "content-type": "application/json", "x-eve-session-id": "eve_chat" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const attachmentData = "data:text/plain;base64,aGk=";
    const initialBody = JSON.stringify({
      message: [
        { type: "text", text: "Read this" },
        { type: "file", data: attachmentData, filename: "note.txt", mediaType: "text/plain" },
      ],
    });

    const initial = await app.request(`/projects/${project.id}/playground/eve/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: initialBody,
    });
    const stream = await app.request(`/projects/${project.id}/playground/eve/v1/session/eve_chat/stream`, {
      headers: { accept: "application/x-ndjson" },
    });

    expect(initial.status).toBe(202);
    await expect(initial.json()).resolves.toMatchObject({ sessionId: "eve_chat", continuationToken: "continue_1" });
    expect(stream.status).toBe(200);
    await expect(stream.text()).resolves.toContain("input.requested");
    await expect(store.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({ eveSessionId: "eve_chat", status: "waiting_approval", continuationToken: "continue_1", completedAt: null }),
    ]);
    const [platformSession] = await store.listSessions(project.id);
    expect(JSON.stringify(await store.listSessionEvents(platformSession!.id))).not.toContain(attachmentData);

    const continuationBody = JSON.stringify({
      continuationToken: "continue_1",
      inputResponses: [{ requestId: "request_1", optionId: "approve" }],
    });
    const continuation = await app.request(`/projects/${project.id}/playground/eve/v1/session/eve_chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: continuationBody,
    });

    expect(continuation.status).toBe(202);
    await expect(continuation.json()).resolves.toMatchObject({ continuationToken: "continue_2" });
    await expect(store.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({ eveSessionId: "eve_chat", status: "running", continuationToken: "continue_2" }),
    ]);
    expect(proxyCalls).toEqual([
      { method: "POST", path: "/eve/v1/session", body: initialBody },
      { method: "GET", path: "/eve/v1/session/eve_chat/stream", body: "" },
      { method: "POST", path: "/eve/v1/session/eve_chat", body: continuationBody },
    ]);
  });

  test("leaves token usage projection to the observer collector", async () => {
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
      session: { usage: { status: "none", inputTokens: 0, outputTokens: 0, reportedSteps: 0 } },
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
    const app = createApp(store, {
      async playgroundRunner({ onEvent }) {
        await onEvent?.({
          type: "step.completed",
          payload: { turnId: "turn_0", stepIndex: 0, usage: { inputTokens: 25, outputTokens: 5 } },
        });
        markStepSent();
        return { response: "Counted live", eveSessionId: "eve_live_usage", events: [] };
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
        expect.objectContaining({ usage: expect.objectContaining({ status: "none", inputTokens: 0, outputTokens: 0 }) }),
      ]);

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

  test("leaves child-session usage attribution to the observer collector", async () => {
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
            data: { runtime: { agentId: "agent_root", agentName: "Root agent", eveVersion: "0.24.2", modelId: "test/root" } },
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
            data: { runtime: { agentId: "agent_researcher", agentName: "Researcher", eveVersion: "0.24.2", modelId: "test/child" } },
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
      const response = await createApp(store, {
        playgroundRunner: async () => ({ response: "Root complete", eveSessionId: "eve_root", events: [] }),
      }).request(`/projects/${project.id}/playground`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Delegate this" }),
      });
      expect(response.status).toBe(201);
      const [session] = await store.listSessions(project.id);
      expect(session?.usage).toMatchObject({ status: "none", inputTokens: 0, outputTokens: 0, reportedSteps: 0 });
      await expect(store.listModelUsageEvents(session!.id)).resolves.toEqual([]);
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

  test("does not fail the root turn when a child stream is unavailable", async () => {
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
      const response = await createApp(store, {
        playgroundRunner: async () => ({ response: "Root still completed", eveSessionId: "eve_root_missing_child", events: [] }),
      }).request(`/projects/${project.id}/playground`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Continue without child telemetry" }),
      });

      expect(response.status).toBe(201);
      const [session] = await store.listSessions(project.id);
      expect(session?.usage).toMatchObject({ status: "none", inputTokens: 0, outputTokens: 0 });
      await expect(store.listSessionEvents(session!.id)).resolves.not.toContainEqual(
        expect.objectContaining({ type: "usage.collection_failed" }),
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
      const response = await createApp(store, {
        playgroundRunner: async () => ({ response: "Remote not fetched", eveSessionId: "eve_remote_parent", events: [] }),
      }).request(`/projects/${project.id}/playground`, {
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
      body: JSON.stringify({ name: "weather-agent", importKind: "git", gitUrl: "https://example.com/weather.git" }),
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

  test("marks a project as deleting, enqueues one deletion job, and rejects duplicate requests", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Delete Me Agent", importKind: "zip", sourcePath: "/tmp/delete-me" });
    const app = createApp(store);

    const response = await app.request(`/projects/${project.id}`, { method: "DELETE" });

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({
      job: expect.objectContaining({ type: "delete_project", status: "queued", projectId: project.id }),
    });
    expect(JSON.stringify(body)).not.toContain("/tmp/delete-me");
    // The delete only happens once the worker processes the job; the DELETE
    // request itself must keep a visible, persisted deleting state.
    await expect(store.getProject(project.id)).resolves.toMatchObject({
      id: project.id,
      deletionStatus: "deleting",
      deletionError: null,
    });

    const duplicate = await app.request(`/projects/${project.id}`, { method: "DELETE" });
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toEqual({ error: "Project is being deleted" });
  });

  test("keeps reads available while rejecting project mutations during deletion", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Deleting Agent", importKind: "zip" });
    const app = createApp(store);
    await app.request(`/projects/${project.id}`, { method: "DELETE" });

    const read = await app.request(`/projects/${project.id}`);
    const mutate = await app.request(`/projects/${project.id}/build-deploy`, { method: "POST" });

    expect(read.status).toBe(200);
    expect(mutate.status).toBe(409);
    await expect(mutate.json()).resolves.toEqual({ error: "Project is being deleted" });
  });
});

async function createScheduleRunFixture(store: Store, createRun = true) {
  const project = await store.createProject({ name: "Scheduled Agent", importKind: "zip" });
  const importJob = await store.claimNextJob("fixture-import");
  await store.completeJob(importJob!.id);
  const revision = await store.recordSourceRevision({
    projectId: project.id,
    kind: "zip",
    sourcePath: "/tmp/scheduled-agent",
    summary: {},
    envVars: [],
    files: [],
    schedules: [],
  });
  const versions = await store.recordScheduleVersions({
    projectId: project.id,
    sourceRevisionId: revision.id,
    definitions: [{
      key: "billing/sweep",
      kind: "handler",
      cron: "0 3 * * *",
      sourcePath: "agent/schedules/billing/sweep.ts",
      definitionHash: "fixture-v1",
    }],
  });
  const schedule = versions[0]?.schedule;
  if (!schedule) throw new Error("Expected schedule fixture.");
  const deployment = await store.recordDeployment({
    projectId: project.id,
    sourceRevisionId: revision.id,
    imageTag: "fixture:scheduler",
    containerName: "fixture-scheduler",
    internalPort: 3000,
    hostPort: 41993,
    runtimeKind: "docker",
  });
  await store.setProjectSchedulerTarget(project.id, deployment.id);
  const run = createRun ? await store.createManualScheduleRun(project.id, schedule.id) : null;
  return { project, schedule, deployment, run: run! };
}

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
