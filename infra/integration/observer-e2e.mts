import assert from "node:assert/strict";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { encryptSecretValue } from "../../packages/core/src/server/secrets.js";
import { createPgliteTestStore } from "../../packages/db/src/test-store.js";
import { createCollectorRuntime } from "../../packages/session-collector/src/runner.js";
import { processNextJob, resolveObserverOutboxDirs } from "../../apps/worker/src/jobs/process.js";
import { createRuntimeAdapterFromEnv } from "../../apps/worker/src/runtime/select.js";

const APP_SECRET_KEY = process.env.APP_SECRET_KEY ?? "eveland-dev-secret-key-000000000";
const FIXTURE_SOURCE_PATH = fileURLToPath(new URL("../../apps/worker/src/integration/fixtures/observer-e2e", import.meta.url));
async function main(): Promise<void> {
  const { store, close } = await createPgliteTestStore();
  const runtime = createRuntimeAdapterFromEnv();
  const project = await store.createProject({ name: `Observer E2E ${Date.now()}`, importKind: "zip", sourcePath: FIXTURE_SOURCE_PATH });
  await store.upsertSecret(project.id, "EVE_MOCK_AUTHORED_MODELS", JSON.stringify(encryptSecretValue("1", APP_SECRET_KEY)));

  let processName: string | null = null;
  try {
  assert.equal(await processNextJob(store, "observer-e2e", { appSecretKey: APP_SECRET_KEY }), true);
  await store.enqueueJob(project.id, "build_deploy");
  assert.equal(await processNextJob(store, "observer-e2e", { appSecretKey: APP_SECRET_KEY }), true);
  const deployment = await store.getCurrentDeployment(project.id);
  assert.ok(deployment, "observer fixture deployment was not recorded");
  processName = deployment.containerName;
  const deploymentObserverRoot = resolveObserverOutboxDirs(process.env, project.id, deployment.id).workerDir;

  const eveSessionId = await runDirectTurn(deployment.hostPort);
  const readyBeforeCollector = await findFiles(deploymentObserverRoot, (name) => name.endsWith(".ready.json"));
  assert.ok(readyBeforeCollector.length > 0, "observer wrote no envelopes while the collector was stopped");
  const observedLineage = await Promise.all(
    readyBeforeCollector.map(async (file) => {
      const envelope = JSON.parse(await readFile(file, "utf8")) as {
        eveSessionId: string;
        parentEveSessionId: string | null;
        agent: { name: string | null };
      };
      return { session: envelope.eveSessionId, parent: envelope.parentEveSessionId, agent: envelope.agent.name };
    }),
  );
  assert.ok(
    observedLineage.some((entry) => entry.parent !== null),
    `directory subagent envelopes had no parent lineage: ${JSON.stringify([...new Map(observedLineage.map((entry) => [entry.session, entry])).values()])}`,
  );
  const replayPath = readyBeforeCollector[0]!;
  const replayEnvelope = await readFile(replayPath);

  const collector = createCollectorRuntime({
    rootDir: deploymentObserverRoot,
    ingest: async (envelope) => {
      await store.ingestObserverEnvelope(envelope);
    },
  });
  await collector.processOnce();
  let sessions = await store.listSessions(project.id);
  assert.equal(sessions.length, 1, "root and subagent must aggregate into one platform session");
  const session = sessions[0]!;
  const nodes = await store.listSessionNodes(session.id);
  const usage = await store.listModelUsageEvents(session.id);
  assert.equal(session.eveSessionId, eveSessionId);
  assert.ok(nodes.length >= 2, `expected root + directory subagent nodes, got ${nodes.length}`);
  assert.ok(usage.length >= 2, `expected provider usage for root + directory subagent, got ${usage.length}`);
  assert.ok(session.usage.reportedSteps >= 2, "session usage aggregate did not include both nodes");

  const usageBeforeReplay = { ...session.usage };
  await writeFile(replayPath, replayEnvelope);
  await collector.processOnce();
  sessions = await store.listSessions(project.id);
  assert.deepEqual(sessions[0]!.usage, usageBeforeReplay, "commit-before-delete replay duplicated token usage");
  assert.equal((await findFiles(deploymentObserverRoot, (name) => name.endsWith(".ready.json"))).length, 0);

  console.log(
    `OBSERVER E2E OK runtime=${runtime.name} session=${session.id} eve=${eveSessionId} nodes=${nodes.length} usageEvents=${usage.length}`,
  );
  } finally {
    if (processName) await runtime.stopProcess(processName).catch(() => undefined);
    await close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function runDirectTurn(hostPort: number): Promise<string> {
  const createResponse = await fetch(`http://127.0.0.1:${hostPort}/eve/v1/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Ask the researcher to investigate observer telemetry." }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await createResponse.text();
  assert.ok(createResponse.ok, `direct private-port POST failed (${createResponse.status}): ${body}`);
  const parsed = JSON.parse(body) as { sessionId?: string };
  const sessionId = parsed.sessionId ?? createResponse.headers.get("x-eve-session-id");
  assert.ok(sessionId, `direct private-port response had no session id: ${body}`);

  const stream = await fetch(`http://127.0.0.1:${hostPort}/eve/v1/session/${encodeURIComponent(sessionId)}/stream`, {
    signal: AbortSignal.timeout(30_000),
  });
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

async function findFiles(root: string, matches: (name: string) => boolean): Promise<string[]> {
  if (!(await stat(root).then((entry) => entry.isDirectory(), () => false))) return [];
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await findFiles(target, matches)));
    else if (entry.isFile() && matches(entry.name)) found.push(target);
  }
  return found.sort();
}
