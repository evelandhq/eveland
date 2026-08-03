import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { encryptSecretValue } from "../../packages/core/src/server/secrets.js";
import { materializeEveFixtureDirectory } from "../../packages/core/src/server/eve-fixture.js";
import {
  deriveAgentTelemetrySecret,
  verifyAgentTelemetryCredential,
} from "../../packages/core/src/server/agent-telemetry-credential.js";
import { createPgliteTestStore } from "../../packages/db/src/test-store.js";
import { projectAgentEventsFromOtlpLogs } from "../../packages/session-collector/src/otlp.js";
import { processNextJob } from "../../apps/worker/src/jobs/process.js";
import { createRuntimeAdapterFromEnv } from "../../apps/worker/src/runtime/select.js";
import { startOtlpTestReceiver } from "./otlp-test-receiver.mts";

const APP_SECRET_KEY = process.env.APP_SECRET_KEY ?? "eveland-dev-secret-key-000000000";
const AGENT_TELEMETRY_SECRET = deriveAgentTelemetrySecret(APP_SECRET_KEY);
const FIXTURE_TEMPLATE_PATH = fileURLToPath(
  new URL("../../apps/worker/src/integration/fixtures/observer-e2e", import.meta.url),
);

async function main(): Promise<void> {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "eveland-observer-e2e-source-"));
  try {
    const fixtureSourcePath = path.join(fixtureRoot, "source");
    await materializeEveFixtureDirectory(FIXTURE_TEMPLATE_PATH, fixtureSourcePath);
    const { store, close } = await createPgliteTestStore();
    let runtime: ReturnType<typeof createRuntimeAdapterFromEnv> | null = null;
    let receiver: Awaited<ReturnType<typeof startOtlpTestReceiver>> | null = null;
    let processName: string | null = null;
    let primaryFailed = false;
    let primaryError: unknown;
    let cleanupFailed = false;
    let cleanupError: unknown;
    try {
      runtime = createRuntimeAdapterFromEnv();
      receiver = await startOtlpTestReceiver();
      const project = await store.createProject({
        name: `OTLP Agent E2E ${Date.now()}`,
        importKind: "zip",
        sourcePath: fixtureSourcePath,
      });
      await store.upsertSecret(
        project.id,
        "EVE_MOCK_AUTHORED_MODELS",
        JSON.stringify(encryptSecretValue("1", APP_SECRET_KEY)),
      );

      assert.equal(
        await processNextJob(store, "otel-agent-e2e", {
          appSecretKey: APP_SECRET_KEY,
        }),
        true,
      );
      await store.enqueueJob(project.id, "build_deploy");
      assert.equal(
        await processNextJob(store, "otel-agent-e2e", {
          appSecretKey: APP_SECRET_KEY,
        }),
        true,
      );
      const deployment = await store.getCurrentDeployment(project.id);
      assert.ok(deployment, "OTLP fixture deployment was not recorded");
      processName = deployment.containerName;

      const eveSessionId = await runDirectTurn(deployment.hostPort);
      const observations = await waitForAgentObservations(receiver);
      assert.ok(
        observations.some((observation) => observation.parentEveSessionId !== null),
        "directory subagent OTLP logs had no parent lineage",
      );
      for (const observation of observations) {
        await store.ingestAgentEvent(observation);
      }

      let sessions = await store.listSessions(project.id);
      assert.equal(
        sessions.length,
        1,
        "root and subagent must aggregate into one platform session",
      );
      const session = sessions[0]!;
      const nodes = await store.listSessionNodes(session.id);
      const usage = await store.listModelUsageEvents(session.id);
      assert.equal(session.eveSessionId, eveSessionId);
      assert.ok(nodes.length >= 2, `expected root + directory subagent nodes, got ${nodes.length}`);
      assert.ok(
        usage.length >= 2,
        `expected provider usage for root + directory subagent, got ${usage.length}`,
      );
      assert.ok(
        session.usage.reportedSteps >= 2,
        "session usage aggregate did not include both nodes",
      );

      const usageBeforeReplay = { ...session.usage };
      for (const observation of observations) {
        await store.ingestAgentEvent(observation);
      }
      sessions = await store.listSessions(project.id);
      assert.deepEqual(
        sessions[0]!.usage,
        usageBeforeReplay,
        "replayed OTLP LogRecords duplicated token usage",
      );

      console.log(
        `OTLP AGENT E2E OK runtime=${runtime.name} session=${session.id} eve=${eveSessionId} nodes=${nodes.length} usageEvents=${usage.length}`,
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
      if (processName && runtime) {
        await attemptCleanup(() => runtime!.stopProcess(processName!));
      }
      if (receiver) await attemptCleanup(() => receiver!.close());
      await attemptCleanup(close);
    }
    if (primaryFailed) {
      if (cleanupFailed) {
        throw new AggregateError(
          [primaryError, cleanupError],
          "Observer E2E scenario and cleanup both failed.",
        );
      }
      throw primaryError;
    }
    if (cleanupFailed) throw cleanupError;
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function waitForAgentObservations(
  receiver: Awaited<ReturnType<typeof startOtlpTestReceiver>>,
) {
  const observations: ReturnType<typeof projectAgentEventsFromOtlpLogs> = [];
  for (let attempt = 0; attempt < 60; attempt += 1) {
    for (const payload of receiver.drain("logs")) {
      observations.push(
        ...projectAgentEventsFromOtlpLogs(payload, {
          resolveDeploymentId: (credential) =>
            credential
              ? verifyAgentTelemetryCredential(credential, AGENT_TELEMETRY_SECRET)?.deploymentId
              : undefined,
        }),
      );
    }
    if (
      observations.some((observation) => eventType(observation.event) === "step.completed") &&
      observations.some((observation) => observation.parentEveSessionId !== null)
    ) {
      return observations;
    }
    await delay(250);
  }
  throw new Error(`Agent did not export complete OTLP logs (observations=${observations.length}).`);
}

function eventType(event: unknown): string | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }
  return typeof (event as { type?: unknown }).type === "string"
    ? (event as { type: string }).type
    : undefined;
}

async function runDirectTurn(hostPort: number): Promise<string> {
  const createResponse = await fetch(`http://127.0.0.1:${hostPort}/eve/v1/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: "Ask the researcher to investigate OpenTelemetry.",
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await createResponse.text();
  assert.ok(
    createResponse.ok,
    `direct private-port POST failed (${createResponse.status}): ${body}`,
  );
  const parsed = JSON.parse(body) as { sessionId?: string };
  const sessionId = parsed.sessionId ?? createResponse.headers.get("x-eve-session-id");
  assert.ok(sessionId, `direct private-port response had no session id: ${body}`);

  const stream = await fetch(
    `http://127.0.0.1:${hostPort}/eve/v1/session/${encodeURIComponent(sessionId)}/stream`,
    { signal: AbortSignal.timeout(30_000) },
  );
  assert.ok(stream.ok && stream.body, `session stream failed (${stream.status})`);
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawSubagent = false;
  let sawTurnCompleted = false;
  while (!sawTurnCompleted) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const event = JSON.parse(line) as { type?: string };
      if (event.type === "subagent.called") sawSubagent = true;
      if (event.type === "turn.completed") sawTurnCompleted = true;
    }
  }
  await reader.cancel().catch(() => undefined);
  assert.ok(sawSubagent, "root did not invoke the directory-form researcher");
  assert.ok(sawTurnCompleted, "root turn did not complete");
  return sessionId;
}
