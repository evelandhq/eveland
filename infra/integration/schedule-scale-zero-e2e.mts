import assert from "node:assert/strict";
import { startWorkflowRuntime, type WorkflowRuntime } from "./workflow-runtime.mts";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "../../apps/gateway/node_modules/@hono/node-server/dist/index.mjs";
import { createApp } from "../../apps/api/src/app.js";
import { createApiActivationClient } from "../../apps/gateway/src/activation-client.js";
import { createGatewayApp } from "../../apps/gateway/src/app.js";
import { sealSecret } from "../../packages/core/src/server/sealed-secret.js";
import { materializeEveFixtureDirectory } from "../../packages/core/src/server/eve-fixture.js";
import { VERIFIED_EVE_VERSION } from "../../packages/core/src/eve-compatibility.js";
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
import {
  isCompletedTurnEvent,
  sessionStreamLineEvents,
} from "../../apps/worker/src/integration/delegated-turn.js";
import { startOtlpTestReceiver } from "./otlp-test-receiver.mts";

const APP_SECRET_KEY = "eveland-dev-secret-key-000000000";
const AGENT_TELEMETRY_SECRET = deriveAgentTelemetrySecret(APP_SECRET_KEY);
const GATEWAY_SERVICE_TOKEN = "schedule-e2e-gateway-service-token-00000000";
const SCHEDULER_RUNTIME_SECRET = "schedule-e2e-runtime-secret-000000000000";
const SCHEDULER_DISPATCH_SECRET = "schedule-e2e-dispatch-secret-0000000000";
const FIXTURE_TEMPLATE = fileURLToPath(new URL("./fixtures/schedule-scale-zero", import.meta.url));
/**
 * A daily schedule authored in an IANA zone with a half-hour offset and no
 * DST, so the instant it is planned for differs from what the same cron
 * would give in UTC or in any whole-hour zone.
 */
const ZONED_SCHEDULE = { key: "zoned", timezone: "Asia/Kolkata", offsetMinutes: 330 } as const;
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
    const zonedDueAt = await writeZonedSchedule(fixture);

    process.env.NODE_ENV = "test";
    process.env.EVELAND_HEALTH_TIMEOUT_MS ??= "30000";

    cleanupStore = await createPgliteTestStore();
    // Turns execute only via the external dispatcher.
    // The dispatch runtime secret shares its env name with the scheduler
    // runtime secret ON PURPOSE (one contract, both ends); this smoke injects
    // its own value into the deployment via jobOptions, so the dispatcher
    // must sign with the same one.
    process.env.WORKFLOW_WORLD_RUNTIME_SECRET = SCHEDULER_RUNTIME_SECRET;
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
      sealSecret("1", APP_SECRET_KEY, "project-secret"),
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
    assert.deepEqual(schedules.map((summary) => summary.schedule.key).sort(), [
      "multi-session",
      ZONED_SCHEDULE.key,
    ]);
    const zoned = schedules.find((summary) => summary.schedule.key === ZONED_SCHEDULE.key)!;
    // Stored under the name ICU resolves the zone to, which can be an older
    // alias of the authored one.
    assert.equal(
      zoned.version?.timezone,
      new Intl.DateTimeFormat("en-US", { timeZone: ZONED_SCHEDULE.timezone }).resolvedOptions()
        .timeZone,
    );

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

    const beforeNativeTick = (await store.listSessionsPage(project.id, { limit: 50 })).items;
    await waitPastNextMinute();
    await projectPendingOtlpLogs(store, otlpReceiver);
    const afterNativeTick = (await store.listSessionsPage(project.id, { limit: 50 })).items;
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

    // The zoned schedule is due at the instant its zone's wall clock reaches
    // the cron, and not a moment earlier. Planning is driven by the clock
    // the planner is handed; the per-minute schedule is due at both instants
    // too, so only the zoned schedule's runs are counted.
    await store.setProjectSchedulerTarget(
      project.id,
      deployment.id,
      new Date(zonedDueAt.getTime() - 90_000),
    );
    const retargeted = (await store.listProjectScheduleSummaries(project.id)).find(
      (summary) => summary.schedule.key === ZONED_SCHEDULE.key,
    )!;
    assert.equal(retargeted.schedule.nextRunAt, zonedDueAt.toISOString());
    const zonedRuns = async () =>
      (
        await store.listScheduleRuns(project.id, {
          scheduleId: retargeted.schedule.id,
          trigger: "cron",
          limit: 10,
        })
      ).items;
    await planDueSchedules(store, { now: new Date(zonedDueAt.getTime() - 1_000), limit: 10 });
    assert.equal((await zonedRuns()).length, 0, "zoned schedule was planned before its instant");
    await planDueSchedules(store, { now: zonedDueAt, limit: 10 });
    const zonedPlanned = await zonedRuns();
    assert.equal(zonedPlanned.length, 1, "zoned schedule was not planned at its instant");
    assert.equal(zonedPlanned[0]!.dueAt, zonedDueAt.toISOString());

    console.log(
      `SCHEDULE SCALE TO ZERO E2E OK runtime=${runtime.name} eve=${VERIFIED_EVE_VERSION} dormant=1 cronRuns=1 sessions=2 nativeDuplicates=0 idleStopped=1 continuationWoke=1 zonedDueAt=${zonedDueAt.toISOString()}`,
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
        let events: ReturnType<typeof sessionStreamLineEvents>;
        try {
          events = sessionStreamLineEvents(JSON.parse(line));
        } catch {
          continue;
        }
        for (const event of events) {
          if (isCompletedTurnEvent(event)) return;
          if (event.type === "turn.settled")
            throw new Error(`turn failed (${event.type}):\n${raw}`);
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  throw new Error(`Session stream ended before the turn completed:\n${raw}`);
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

/**
 * Authors the zoned schedule for a wall-clock time about twelve hours away,
 * so its first instant can never fall inside the per-minute schedule's
 * planning window above. Returns that instant, worked out from the zone's
 * fixed offset rather than by the code under test.
 */
async function writeZonedSchedule(fixture: string): Promise<Date> {
  const dueAt = new Date(Date.now() + 12 * 3_600_000);
  dueAt.setUTCSeconds(0, 0);
  const utcMinuteOfDay = dueAt.getUTCHours() * 60 + dueAt.getUTCMinutes();
  const localMinuteOfDay = (utcMinuteOfDay + ZONED_SCHEDULE.offsetMinutes) % 1_440;
  const cron = `${localMinuteOfDay % 60} ${Math.floor(localMinuteOfDay / 60)} * * *`;
  await writeFile(
    path.join(fixture, "agent/schedules", `${ZONED_SCHEDULE.key}.md`),
    `---\ncron: "${cron}"\ntimezone: "${ZONED_SCHEDULE.timezone}"\n---\n\nRun the zoned fixture schedule.\n`,
  );
  return dueAt;
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
