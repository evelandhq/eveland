import { describe, expect, test, vi } from "vitest";
import { createMemoryStore, type Store } from "@eveland/db";
import {
  allocateAvailableHostPort,
  cleanupExpiredSourcePreflights,
  invalidateGatewayRouteCache,
  processNextJob,
  processNextSourcePreflight,
  runWithJobHeartbeat,
  resolveObserverOutboxDirs,
  resolveSandboxCacheDirs,
  type ScheduleDispatchInput,
} from "./process.js";
import { processSafeName, type RuntimeAdapter } from "../runtime/types.js";
import { deriveProjectWorkflowUrl } from "../runtime/workflow-world-bootstrap.js";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { encryptSecretValue } from "@eveland/core/server/secrets";
import type { DeploymentRecord } from "@eveland/core/contracts";
import { verifyScheduleDispatchCredential } from "@eveland/core/server/scheduler-dispatch";
import { createFixtureEveProject } from "./process.test-support.js";

describe("processNextJob", () => {
  test("validates an Eve source before a Project exists", async () => {
    const store = createMemoryStore();
    const sourcePath = await createFixtureEveProject();
    const preflight = await store.createSourcePreflight({
      userId: "user_local_admin",
      kind: "zip",
      sourcePath,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(processNextSourcePreflight(store, "preflight-worker")).resolves.toBe(true);
    await expect(store.getSourcePreflight(preflight.id, "user_local_admin")).resolves.toMatchObject({
      status: "completed",
      summary: expect.objectContaining({ eveVersion: expect.any(String) }),
    });
    await expect(store.listProjects()).resolves.toEqual([]);
  });

  test("reports invalid Eve source without creating a Project", async () => {
    const store = createMemoryStore();
    const sourcePath = await mkdtemp(path.join(os.tmpdir(), "eveland-invalid-preflight-"));
    await writeFile(path.join(sourcePath, "package.json"), JSON.stringify({ dependencies: { eve: "0.23.0" } }));
    const preflight = await store.createSourcePreflight({
      userId: "user_local_admin",
      kind: "zip",
      sourcePath,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(processNextSourcePreflight(store, "preflight-worker")).resolves.toBe(true);
    await expect(store.getSourcePreflight(preflight.id, "user_local_admin")).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining("Eve"),
    });
    await expect(store.listProjects()).resolves.toEqual([]);
    await rm(sourcePath, { recursive: true, force: true });
  });

  test("cleans expired managed preflight snapshots but preserves outside paths", async () => {
    const store = createMemoryStore();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "eveland-preflight-cleanup-"));
    const managedSource = path.join(dataDir, "preflights", "pre_managed", "source");
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "eveland-preflight-outside-"));
    const outsideSource = path.join(outsideRoot, "source");
    await Promise.all([mkdir(managedSource, { recursive: true }), mkdir(outsideSource, { recursive: true })]);

    for (const sourcePath of [managedSource, outsideSource]) {
      const preflight = await store.createSourcePreflight({
        userId: "user_local_admin",
        kind: "zip",
        sourcePath,
        expiresAt: new Date("2026-07-17T00:00:00.000Z"),
      });
      const claimed = await store.claimNextSourcePreflight("cleanup-worker", new Date("2026-07-16T00:00:00.000Z"));
      await store.completeSourcePreflight(preflight.id, claimed!.attempts, { sourcePath, commitSha: null, summary: {} });
    }

    await expect(cleanupExpiredSourcePreflights(
      store,
      dataDir,
      new Date("2026-07-18T00:00:00.000Z"),
    )).resolves.toBe(1);
    await expect(access(managedSource)).rejects.toThrow();
    await expect(access(outsideSource)).resolves.toBeUndefined();
    await Promise.all([
      rm(dataDir, { recursive: true, force: true }),
      rm(outsideRoot, { recursive: true, force: true }),
    ]);
  });

  test("heartbeats while a claimed job is still running", async () => {
    let finish!: (value: string) => void;
    let heartbeatObserved!: () => void;
    const observed = new Promise<void>((resolve) => { heartbeatObserved = resolve; });

    const running = runWithJobHeartbeat({
      intervalMs: 1,
      heartbeat: async () => { heartbeatObserved(); return true; },
      work: () => new Promise<string>((resolve) => { finish = resolve; }),
    });
    await observed;
    finish("done");

    await expect(running).resolves.toBe("done");
  });

  test("starts an API-claimed RuntimeInstance from its prebuilt Release", async () => {
    const store = createMemoryStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({ name: "Wake Deployment", importKind: "zip" });
    const importJob = await store.claimNextJob("fixture-import");
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
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "fixture:wake",
      containerName: "fixture-wake",
      internalPort: 3000,
      hostPort: 41992,
      runtimeKind: "docker",
    });
    await store.updateDeploymentStatus(deployment.id, "stopped");
    const claim = await store.acquireActivationLease({
      deploymentId: deployment.id,
      kind: "public_request",
      ownerId: "req_wake",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await store.enqueueJob(project.id, "ensure_deployment_running", {
      deploymentId: deployment.id,
      runtimeInstanceId: claim.runtimeInstance.id,
    });
    const ensureProcess = vi.fn(async () => ({ internalPort: 3000, log: "started" }));
    const runtime: RuntimeAdapter = {
      name: "docker",
      async buildRelease() { throw new Error("not used"); },
      async startProcess() { return { internalPort: 3000, log: "started" }; },
      ensureProcess,
      async stopProcess() {},
    };

    await expect(processNextJob(store, "wake-worker", {
      runtime,
      waitForDeployment: async () => {},
    })).resolves.toBe(true);

    expect(ensureProcess).toHaveBeenCalledTimes(1);
    await expect(store.getRuntimeInstance(claim.runtimeInstance.id)).resolves.toMatchObject({
      status: "ready",
      endpointPort: deployment.hostPort,
    });
    await expect(store.getDeployment(deployment.id)).resolves.toMatchObject({ status: "running" });
  });

  test("dispatches a ScheduleRun once to its pinned Deployment and preserves returned Sessions", async () => {
    const store = createMemoryStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({ name: "Trigger Schedule", importKind: "zip" });
    const importJob = await store.claimNextJob("fixture-import");
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
    const versions = await store.recordScheduleVersions({
      projectId: project.id,
      sourceRevisionId: revision.id,
      definitions: [{
        key: "billing/sweep",
        kind: "handler",
        cron: "0 3 * * *",
        sourcePath: "agent/schedules/billing/sweep.ts",
        definitionHash: "trigger-v1",
      }],
    });
    const schedule = versions[0]?.schedule;
    if (!schedule) throw new Error("Expected schedule fixture.");
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "fixture:trigger",
      containerName: "fixture-trigger",
      internalPort: 3000,
      hostPort: 41994,
      runtimeKind: "docker",
    });
    await store.setProjectSchedulerTarget(project.id, deployment.id);
    const run = await store.createManualScheduleRun(project.id, schedule.id, new Date("2026-07-15T01:02:03.000Z"));
    await store.enqueueJob(project.id, "trigger_schedule", { scheduleRunId: run.id });
    const dispatchSecret = "schedule-dispatch-secret-at-least-32-bytes";
    const runtime: RuntimeAdapter = {
      name: "docker",
      async buildRelease() { throw new Error("not used"); },
      async startProcess() { return { internalPort: 3000, log: "started" }; },
      async ensureProcess() { return { internalPort: 3000, log: "started" }; },
      async stopProcess() {},
    };

    const dispatchSchedule = vi.fn(async (input: ScheduleDispatchInput) => {
      expect(input).toMatchObject({
        scheduleRunId: run.id,
        scheduleKey: schedule.key,
        deploymentId: deployment.id,
        hostPort: deployment.hostPort,
      });
      expect(verifyScheduleDispatchCredential(input.credential, dispatchSecret)).toMatchObject({
        scheduleRunId: run.id,
        deploymentId: deployment.id,
        scheduleKey: schedule.key,
      });
      await store.redeemScheduleRunDispatch(run.id, deployment.id);
      await store.completeScheduleRun(run.id, { status: "succeeded", eveSessionIds: ["eve_worker_schedule"] });
      return { sessionIds: ["eve_worker_schedule"] };
    });
    const options = {
      runtime,
      waitForDeployment: async () => {},
      schedulerDispatchSecret: dispatchSecret,
      schedulerRuntimeSecret: "runtime-secret-at-least-32-bytes-long",
      dispatchSchedule,
    };
    await expect(processNextJob(store, "schedule-worker", options)).resolves.toBe(true);
    await expect(processNextJob(store, "schedule-worker", options)).resolves.toBe(true);

    await expect(store.getScheduleRun(run.id)).resolves.toMatchObject({ status: "succeeded", attempt: 1 });
    expect(dispatchSchedule).toHaveBeenCalledTimes(1);
    await expect(store.listSessions(project.id)).resolves.toContainEqual(expect.objectContaining({
      eveSessionId: "eve_worker_schedule",
      scheduleRunId: run.id,
    }));
    await expect(store.hasActiveActivationLeases(deployment.id)).resolves.toBe(false);

    const unknownRun = await store.createManualScheduleRun(project.id, schedule.id);
    await expect(processNextJob(store, "schedule-worker", {
      ...options,
      dispatchSchedule: async () => {
        await store.redeemScheduleRunDispatch(unknownRun.id, deployment.id);
        throw new Error("runtime connection closed after dispatch claim");
      },
    })).resolves.toBe(true);
    await expect(store.getScheduleRun(unknownRun.id)).resolves.toMatchObject({
      status: "dispatch_unknown",
      attempt: 1,
      error: "runtime connection closed after dispatch claim",
    });
    await expect(store.hasActiveActivationLeases(deployment.id)).resolves.toBe(false);
  });

  test("invalidates each materialized Gateway hostname when service credentials are configured", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    await invalidateGatewayRouteCache(
      { EVELAND_GATEWAY_INTERNAL_URL: "http://gateway:4080", EVELAND_GATEWAY_SERVICE_TOKEN: "secret" },
      [{ hostname: "p-one.agent.localhost" }, { hostname: "d-one--p-one.agent.localhost" }],
      async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(null, { status: 200 });
      },
    );
    expect(calls).toEqual([
      expect.objectContaining({ url: "http://gateway:4080/internal/cache/invalidate" }),
      expect.objectContaining({ url: "http://gateway:4080/internal/cache/invalidate" }),
    ]);
    expect(calls.map((call) => call.init?.body)).toEqual([
      JSON.stringify({ hostname: "p-one.agent.localhost" }),
      JSON.stringify({ hostname: "d-one--p-one.agent.localhost" }),
    ]);
  });

  test("maps the worker-visible observer outbox to its Docker-host path", () => {
    expect(
      resolveObserverOutboxDirs(
        { EVELAND_DATA_DIR: "/workspace/.eveland-data", EVELAND_HOST_DATA_DIR: "/host/eveland/.eveland-data" },
        "proj_123",
        "dep_456",
      ),
    ).toEqual({
      workerDir: "/workspace/.eveland-data/observer/proj_123/dep_456",
      hostDir: "/host/eveland/.eveland-data/observer/proj_123/dep_456",
    });
  });

  test("maps the durable sandbox cache to worker-visible and Docker-host paths", () => {
    expect(
      resolveSandboxCacheDirs(
        { EVELAND_DATA_DIR: "/workspace/.eveland-data", EVELAND_HOST_DATA_DIR: "/host/eveland/.eveland-data" },
        "proj_123",
      ),
    ).toEqual({
      workerDir: "/workspace/.eveland-data/sandbox/proj_123",
      hostDir: "/host/eveland/.eveland-data/sandbox/proj_123",
    });
  });

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

});
