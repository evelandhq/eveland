import assert from "node:assert/strict";
import { startWorkflowRuntime, type WorkflowRuntime } from "./workflow-runtime.mts";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "../../apps/gateway/node_modules/@hono/node-server/dist/index.mjs";
import { createApp } from "../../apps/api/src/app.js";
import { createApiActivationClient } from "../../apps/gateway/src/activation-client.js";
import { createGatewayApp } from "../../apps/gateway/src/app.js";
import { encryptSecretValue } from "../../packages/core/src/server/secrets.js";
import { materializeEveFixtureDirectory } from "../../packages/core/src/server/eve-fixture.js";
import { LATEST_VERIFIED_EVE_VERSION } from "../../packages/core/src/eve-compatibility.js";
import {
  deriveAgentTelemetrySecret,
  verifyAgentTelemetryCredential,
} from "../../packages/core/src/server/agent-telemetry-credential.js";
import { createPgliteTestStore } from "../../packages/db/src/test-store.js";
import { projectAgentEventsFromOtlpLogs } from "../../packages/session-collector/src/otlp.js";
import { processNextJob, type ProcessJobOptions } from "../../apps/worker/src/jobs/process.js";
import { createRuntimeAdapterFromEnv } from "../../apps/worker/src/runtime/select.js";
import { reapIdleDeployments } from "../../apps/worker/src/runtime/idle-reaper.js";
import { planDueSchedules } from "../../apps/worker/src/scheduler/planner.js";
import { startOtlpTestReceiver } from "./otlp-test-receiver.mts";

const APP_SECRET_KEY = "eveland-dev-secret-key-000000000";
const AGENT_TELEMETRY_SECRET = deriveAgentTelemetrySecret(APP_SECRET_KEY);
const GATEWAY_SERVICE_TOKEN = "schedule-e2e-gateway-service-token-00000000";
const SCHEDULER_RUNTIME_SECRET = "schedule-e2e-runtime-secret-000000000000";
const SCHEDULER_DISPATCH_SECRET = "schedule-e2e-dispatch-secret-0000000000";
const FIXTURE_TEMPLATE = fileURLToPath(new URL("./fixtures/schedule-scale-zero", import.meta.url));
type TestStore = Awaited<ReturnType<typeof createPgliteTestStore>>["store"];
type TestRuntime = ReturnType<typeof createRuntimeAdapterFromEnv>;

async function main(): Promise<void> {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "eveland-schedule-e2e-source-"));
  const priorNodeEnv = process.env.NODE_ENV;
  let cleanupStore: Awaited<ReturnType<typeof createPgliteTestStore>> | null = null;
  let cleanupWorkflowRuntime: WorkflowRuntime | null = null;
  let cleanupRuntime: TestRuntime | null = null;
  let cleanupReceiver: Awaited<ReturnType<typeof startOtlpTestReceiver>> | null = null;
  let deploymentName: string | null = null;
  let releaseRef: string | null = null;
  let apiServer: ReturnType<typeof serve> | null = null;
  let primaryFailed = false;
  let primaryError: unknown;
  let cleanupFailed = false;
  let cleanupError: unknown;

  try {
    const fixture = path.join(fixtureRoot, "source");
    await materializeEveFixtureDirectory(FIXTURE_TEMPLATE, fixture);

    process.env.NODE_ENV = "test";
    process.env.EVELAND_HEALTH_TIMEOUT_MS ??= "30000";

    cleanupStore = await createPgliteTestStore();
    // Post-cutover: turns execute only via the external dispatcher.
    // The dispatch runtime secret shares its env name with the scheduler
    // runtime secret ON PURPOSE (one contract, both ends); this smoke injects
    // its own value into the deployment via jobOptions, so the dispatcher
    // must sign with the same one.
    process.env.EVELAND_SCHEDULER_RUNTIME_SECRET = SCHEDULER_RUNTIME_SECRET;
    cleanupWorkflowRuntime = await startWorkflowRuntime(cleanupStore.store);
    const { store } = cleanupStore;
    const runtime = createRuntimeAdapterFromEnv();
    cleanupRuntime = runtime;
    const otlpReceiver = await startOtlpTestReceiver();
    cleanupReceiver = otlpReceiver;
    let jobOptions: ProcessJobOptions;

    const api = createApp(store, {
      appSecretKey: APP_SECRET_KEY,
      gatewayServiceToken: GATEWAY_SERVICE_TOKEN,
      schedulerRuntimeSecret: SCHEDULER_RUNTIME_SECRET,
      schedulerDispatchSecret: SCHEDULER_DISPATCH_SECRET,
      runtimeActivationLeaseTtlMs: 30_000,
      runtimeActivationWaitTimeoutMs: 30_000,
      runtimeActivationWaiter: async (claim) => {
        if (claim.runtimeInstance.status === "starting") {
          assert.equal(await processNextJob(store, "schedule-e2e-activation", jobOptions), true);
        }
        const current = await store.getRuntimeInstance(claim.runtimeInstance.id);
        assert.ok(current, "activation RuntimeInstance disappeared");
        return current;
      },
    });
    apiServer = serve({ fetch: api.fetch, port: 0 });
    if (!apiServer.listening) await once(apiServer, "listening");
    const apiAddress = apiServer.address();
    if (!apiAddress || typeof apiAddress === "string")
      throw new Error("Schedule E2E API did not bind.");
    const apiOrigin = `http://127.0.0.1:${apiAddress.port}`;
    const deploymentApiHost = runtime.name === "docker" ? "host.docker.internal" : "127.0.0.1";
    jobOptions = {
      runtime,
      appSecretKey: APP_SECRET_KEY,
      nodeEnv: "development",
      schedulerRuntimeSecret: SCHEDULER_RUNTIME_SECRET,
      schedulerDispatchSecret: SCHEDULER_DISPATCH_SECRET,
      schedulerRedeemUrl: `http://${deploymentApiHost}:${apiAddress.port}/internal/scheduler/dispatch`,
    };

    const project = await store.createProject({
      name: `Schedule Scale Zero ${runtime.name} ${Date.now()}`,
      importKind: "zip",
      sourcePath: fixture,
    });
    await store.upsertSecret(
      project.id,
      "EVE_MOCK_AUTHORED_MODELS",
      JSON.stringify(encryptSecretValue("1", APP_SECRET_KEY)),
    );
    assert.equal(
      await processNextJob(store, "schedule-e2e", jobOptions),
      true,
      "import_source did not run",
    );
    await store.enqueueJob(project.id, "build_deploy");
    assert.equal(
      await processNextJob(store, "schedule-e2e", jobOptions),
      true,
      "build_deploy did not run",
    );

    const deployment = await store.getCurrentDeployment(project.id);
    assert.ok(deployment, "schedule fixture Deployment was not recorded");
    deploymentName = deployment.containerName;
    const release = await store.getRelease(deployment.releaseId);
    assert.ok(release, "schedule fixture Release was not recorded");
    releaseRef = release.imageTag;
    const schedules = await store.listProjectScheduleSummaries(project.id);
    assert.equal(schedules.length, 1);
    const schedule = schedules[0]!.schedule;
    assert.equal(schedule.key, "multi-session");

    const gateway = createGatewayApp(store, {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret: "schedule-e2e-affinity-secret",
      activationClient: createApiActivationClient({
        apiUrl: apiOrigin,
        serviceToken: GATEWAY_SERVICE_TOKEN,
      }),
      activationRenewIntervalMs: 5_000,
      routeCacheTtlMs: 0,
    });
    const publicOrigin = `http://${project.slug}.agent.localhost`;

    const initial = await gateway.request(`${publicOrigin}/eve/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Create the continuation fixture." }),
    });
    const initialBody = await initial.text();
    assert.ok(initial.ok, `initial public turn failed (${initial.status}): ${initialBody}`);
    const initialSessionId = sessionResult(initialBody, initial.headers).sessionId;
    assert.ok(initialSessionId, `initial public turn returned no Session ID: ${initialBody}`);
    await consumeTurn(
      gateway,
      `${publicOrigin}/eve/v1/session/${encodeURIComponent(initialSessionId)}/stream?startIndex=0`,
    );
    const binding = await store.findSessionBinding(project.id, initialSessionId);
    assert.equal(binding?.deploymentId, deployment.id);

    assert.equal(await stopAfterIdle(store, runtime), 1);
    assert.equal((await store.getDeployment(deployment.id))?.status, "stopped");
    assert.notEqual(await runtime.inspectProcess?.(deployment.containerName), "ready");

    await store.setProjectSchedulerTarget(
      project.id,
      deployment.id,
      new Date(Date.now() - 120_000),
    );
    assert.equal(await planDueSchedules(store, { now: new Date(), limit: 10 }), 1);
    const planned = await store.listScheduleRuns(project.id, { trigger: "cron", limit: 10 });
    assert.equal(planned.items.length, 1);
    const runId = planned.items[0]!.id;
    assert.equal(
      await processNextJob(store, "schedule-e2e", jobOptions),
      true,
      "trigger_schedule did not run",
    );
    const dispatched = await store.getScheduleRunDetail(runId);
    assert.equal(
      dispatched?.status,
      "running",
      dispatched?.error ?? "ScheduleRun did not stay active",
    );
    assert.equal(dispatched?.attempt, 1);
    assert.equal(dispatched?.sessions.length, 2);
    assert.equal(
      await stopAfterIdle(store, runtime),
      0,
      "idle reaping stopped a RuntimeInstance before its scheduled Sessions reached a turn boundary",
    );

    const observed = await waitForObservedUsage(store, otlpReceiver, runId);
    assert.equal(
      observed.status,
      "succeeded",
      observed.error ?? "OTLP telemetry did not settle ScheduleRun",
    );
    assert.equal(observed.sessions.length, 2);
    assert.ok(observed.usage.reportedSteps >= 2, "schedule Session usage was not projected");

    const beforeNativeTick = await store.listSessions(project.id);
    await waitPastNextMinute();
    await projectPendingOtlpLogs(store, otlpReceiver);
    const afterNativeTick = await store.listSessions(project.id);
    assert.equal(
      afterNativeTick.length,
      beforeNativeTick.length,
      "native Eve cron duplicated authored execution",
    );
    assert.equal((await store.getScheduleRunDetail(runId))?.sessions.length, 2);

    assert.equal(await stopAfterIdle(store, runtime), 1);
    assert.equal((await store.getDeployment(deployment.id))?.status, "stopped");

    const continuation = await gateway.request(
      `${publicOrigin}/eve/v1/session/${encodeURIComponent(initialSessionId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "Continue after the idle shutdown.",
        }),
      },
    );
    const continuationBody = await continuation.text();
    assert.ok(continuation.ok, `continuation failed (${continuation.status}): ${continuationBody}`);
    assert.ok(
      sessionResult(continuationBody, continuation.headers).sessionId,
      `continuation returned no accepted workflow run: ${continuationBody}`,
    );
    const readyInstances = await store.listRuntimeInstances(["ready"], 10);
    assert.equal(readyInstances.at(-1)?.deploymentId, deployment.id);
    assert.equal(
      (await store.findSessionBinding(project.id, initialSessionId))?.deploymentId,
      deployment.id,
    );

    console.log(
      `SCHEDULE SCALE TO ZERO E2E OK runtime=${runtime.name} eve=${LATEST_VERIFIED_EVE_VERSION} dormant=1 cronRuns=1 sessions=2 nativeDuplicates=0 idleStopped=1 continuationWoke=1`,
    );
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
  } finally {
    const attemptCleanup = async (action: () => Promise<void>): Promise<void> => {
      try {
        await action();
      } catch (error) {
        cleanupFailed = true;
        cleanupError ??= error;
      }
    };

    const runtime = cleanupRuntime;
    if (deploymentName && runtime) {
      await attemptCleanup(() => runtime.stopProcess(deploymentName!));
    }
    if (releaseRef && runtime?.removeRelease) {
      await attemptCleanup(() => runtime.removeRelease!(releaseRef!));
    }
    if (apiServer) {
      await attemptCleanup(() => new Promise<void>((resolve) => apiServer!.close(() => resolve())));
    }
    if (cleanupReceiver) {
      await attemptCleanup(() => cleanupReceiver!.close());
    }
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorNodeEnv;
    if (cleanupStore) {
      if (cleanupWorkflowRuntime) {
        await attemptCleanup(() => cleanupWorkflowRuntime!.stop());
      }
      await attemptCleanup(() => cleanupStore!.close());
    }
    await attemptCleanup(() => rm(fixtureRoot, { recursive: true, force: true }));
  }
  if (primaryFailed) {
    if (cleanupFailed) {
      throw new AggregateError(
        [primaryError, cleanupError],
        "Schedule scale-to-zero E2E scenario and cleanup both failed.",
      );
    }
    throw primaryError;
  }
  if (cleanupFailed) throw cleanupError;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function stopAfterIdle(
  candidateStore: TestStore,
  candidateRuntime: TestRuntime,
): Promise<number> {
  return reapIdleDeployments(candidateStore, {
    now: new Date(Date.now() + 600_000),
    idleTtlMs: 0,
    limit: 10,
    runtimeForKind: () => candidateRuntime,
  });
}

async function consumeTurn(
  gateway: ReturnType<typeof createGatewayApp>,
  url: string,
): Promise<void> {
  const response = await gateway.request(url, { signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok && response.body, `Session stream failed (${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let consumed = 0;
  const deadline = Date.now() + 30_000;
  try {
    for (;;) {
      const chunk = await Promise.race([
        reader.read(),
        delay(Math.max(1, deadline - Date.now())).then(() => {
          throw new Error(`Session stream timed out:\n${raw}`);
        }),
      ]);
      if (chunk.done) break;
      raw += decoder.decode(chunk.value, { stream: true });
      let newline: number;
      while ((newline = raw.indexOf("\n", consumed)) >= 0) {
        const line = raw.slice(consumed, newline).trim();
        consumed = newline + 1;
        if (!line) continue;
        try {
          const event = JSON.parse(line) as { type?: unknown };
          if (event.type === "turn.completed" || event.type === "session.waiting") return;
          if (event.type === "turn.failed") throw new Error(`turn.failed observed:\n${raw}`);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("turn.failed")) throw error;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  throw new Error(`Session stream ended before turn.completed:\n${raw}`);
}

async function waitForObservedUsage(
  candidateStore: TestStore,
  receiver: Awaited<ReturnType<typeof startOtlpTestReceiver>>,
  scheduleRunId: string,
) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await projectPendingOtlpLogs(candidateStore, receiver);
    const detail = await candidateStore.getScheduleRunDetail(scheduleRunId);
    if (
      detail?.status === "succeeded" &&
      detail.sessions.length === 2 &&
      detail.usage.reportedSteps >= 2
    )
      return detail;
    await delay(250);
  }
  throw new Error("OTLP logs did not project both scheduled Sessions and their provider usage.");
}

async function projectPendingOtlpLogs(
  candidateStore: TestStore,
  receiver: Awaited<ReturnType<typeof startOtlpTestReceiver>>,
) {
  for (const payload of receiver.drain("logs")) {
    for (const observation of projectAgentEventsFromOtlpLogs(payload, {
      resolveDeploymentId: (credential) =>
        credential
          ? verifyAgentTelemetryCredential(credential, AGENT_TELEMETRY_SECRET)?.deploymentId
          : undefined,
    })) {
      await candidateStore.ingestAgentEvent(observation);
    }
  }
}

async function waitPastNextMinute(): Promise<void> {
  const waitMs = 60_000 - (Date.now() % 60_000) + 5_000;
  await delay(waitMs);
}

function sessionResult(body: string, headers: Headers): { sessionId: string | null } {
  try {
    const parsed = JSON.parse(body) as { sessionId?: unknown };
    return {
      sessionId:
        typeof parsed.sessionId === "string" ? parsed.sessionId : headers.get("x-eve-session-id"),
    };
  } catch {
    // Fall through to the canonical response header.
  }
  return { sessionId: headers.get("x-eve-session-id") };
}
