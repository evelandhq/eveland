import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { sealSecret } from "../../packages/core/src/server/sealed-secret.js";
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
import {
  sessionStreamLineEvents,
  watchDelegatedTurn,
} from "../../apps/worker/src/integration/delegated-turn.js";
import { startWorkflowRuntime, type WorkflowRuntime } from "./workflow-runtime.mts";

/**
 * One budget for the whole delegation. eve holds the root turn for the agent
 * call (`child.opened`, `call.settled`, then `turn.settled`), so the budget
 * covers the child inside the turn.
 */
const DELEGATED_TURN_BUDGET_MS = 60_000;

const APP_SECRET_KEY = process.env.APP_SECRET_KEY ?? "eveland-dev-secret-key-000000000";
const AGENT_TELEMETRY_SECRET = deriveAgentTelemetrySecret(APP_SECRET_KEY);
const FIXTURE_TEMPLATE_PATH = fileURLToPath(
  new URL("../../apps/worker/src/integration/fixtures/observer-e2e", import.meta.url),
);
const EXTENSION_TEMPLATE_PATH = fileURLToPath(
  new URL("../../apps/worker/src/integration/fixtures/observer-e2e-extension", import.meta.url),
);
// The workspace's eve, the verified version the fixture also pins; it only
// builds the Extension package here, never the Agent.
const EVE_PACKAGE_PATH = fileURLToPath(
  new URL("../../packages/agent-observer/node_modules/eve", import.meta.url),
);
const EXTENSION_PACKAGE = "eveland-probe-extension";
const execFileAsync = promisify(execFile);

/**
 * Every child the root delegates to, by the name it calls each one: a local
 * directory-form subagent and an installed Extension's. Both run with the
 * observer hook and on the platform sandbox. File-form subagents are not
 * here: eve gives them its own default sandbox, which a Release refuses.
 */
const CHILDREN = {
  researcher: "local",
  probe__helper: "extension",
} as const;
type ChildName = keyof typeof CHILDREN;

async function main(): Promise<void> {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "eveland-observer-e2e-source-"));
  try {
    const fixtureSourcePath = path.join(fixtureRoot, "source");
    await materializeEveFixtureDirectory(FIXTURE_TEMPLATE_PATH, fixtureSourcePath);
    await mountProbeExtension(fixtureRoot, fixtureSourcePath);
    const { store, close } = await createPgliteTestStore();
    let runtime: ReturnType<typeof createRuntimeAdapterFromEnv> | null = null;
    let receiver: Awaited<ReturnType<typeof startOtlpTestReceiver>> | null = null;
    let workflowRuntime: WorkflowRuntime | null = null;
    let processName: string | null = null;
    let primaryFailed = false;
    let primaryError: unknown;
    let cleanupFailed = false;
    let cleanupError: unknown;
    try {
      runtime = createRuntimeAdapterFromEnv();
      receiver = await startOtlpTestReceiver();
      // This fixture's turn executes only through the external dispatcher;
      // start the workflow runtime BEFORE the build so the
      // scratch World URL is injected into the Release.
      workflowRuntime = await startWorkflowRuntime(store);
      const project = await store.createProject({
        name: `OTLP Agent E2E ${Date.now()}`,
        importKind: "zip",
        sourcePath: fixtureSourcePath,
      });
      await store.upsertSecret(
        project.id,
        "EVE_MOCK_AUTHORED_MODELS",
        sealSecret("1", APP_SECRET_KEY, "project-secret"),
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
      // processNextJob returns true for a job it merely *ran*; a build that
      // failed leaves its reason in the project's log, not on stdout, and this
      // store is a temporary one that disappears with the process.
      assert.ok(
        deployment,
        `OTLP fixture deployment was not recorded; build/deploy log:\n${(
          await store.listLogs(project.id)
        )
          .map((entry) => `  [${entry.type}] ${entry.line}`)
          .join("\n")}`,
      );
      processName = deployment.containerName;

      const { eveSessionId, children } = await runDirectTurn(deployment.hostPort);
      const observations = await waitForAgentObservations(receiver, children);
      assert.ok(
        observations.some((observation) => observation.parentEveSessionId !== null),
        "directory subagent OTLP logs had no parent lineage",
      );
      for (const observation of observations) {
        await store.ingestAgentEvent(observation);
      }

      let sessions = (await store.listSessionsPage(project.id, { limit: 10 })).items;
      assert.equal(
        sessions.length,
        1,
        "root and subagents must aggregate into one platform session",
      );
      const session = sessions[0]!;
      const nodes = await store.listSessionNodes(session.id);
      const usage = await store.listModelUsageEvents(session.id);
      assert.equal(session.eveSessionId, eveSessionId);
      assert.equal(
        nodes.length,
        1 + children.size,
        `expected the root and one node per child, got ${nodes.map((node) => node.agentName).join(", ")}`,
      );
      for (const [name, childSessionId] of children) {
        const node = nodes.find((candidate) => candidate.eveSessionId === childSessionId);
        assert.ok(node, `${name} has no session node`);
        assert.equal(node.parentEveSessionId, eveSessionId, `${name} is not under the root`);
        const childUsage = usage.filter((event) => event.eveSessionId === childSessionId);
        assert.ok(
          childUsage.some((event) => event.usageReported),
          `${name} (${CHILDREN[name]}) has no provider usage on its own node`,
        );
      }
      assert.equal(
        session.usage.reportedSteps,
        usage.filter((event) => event.usageReported).length,
        "session usage aggregate did not count every node's usage exactly once",
      );

      const usageBeforeReplay = { ...session.usage };
      for (const observation of observations) {
        await store.ingestAgentEvent(observation);
      }
      sessions = (await store.listSessionsPage(project.id, { limit: 10 })).items;
      assert.deepEqual(
        sessions[0]!.usage,
        usageBeforeReplay,
        "replayed OTLP LogRecords duplicated token usage",
      );

      console.log(
        `OTLP AGENT E2E OK runtime=${runtime.name} session=${session.id} eve=${eveSessionId} nodes=${nodes.length} usageEvents=${usage.length} extensionSubagent=1`,
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
      if (workflowRuntime) await attemptCleanup(() => workflowRuntime!.stop());
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
  children: ReadonlyMap<ChildName, string>,
) {
  const observations: ReturnType<typeof projectAgentEventsFromOtlpLogs> = [];
  // Provider usage is its own `usage.recorded` fact, which each hooked child
  // reports on its own session.
  const usageReached = (childSessionId: string) =>
    observations.some(
      (observation) =>
        eventType(observation.event) === "usage.recorded" &&
        observation.eveSessionId === childSessionId,
    );
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
    if ([...children.values()].every(usageReached)) return observations;
    await delay(250);
  }
  const missing = [...children].filter(([, id]) => !usageReached(id)).map(([name]) => name);
  throw new Error(
    `Agent did not export usage for every child (missing=${missing.join(", ")}, observations=${observations.length}).`,
  );
}

function eventType(event: unknown): string | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }
  return typeof (event as { type?: unknown }).type === "string"
    ? (event as { type: string }).type
    : undefined;
}

async function runDirectTurn(
  hostPort: number,
): Promise<{ eveSessionId: string; children: Map<ChildName, string> }> {
  const createResponse = await fetch(`http://127.0.0.1:${hostPort}/eve/v1/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      // eve's mock model answers this directive with one call per named tool.
      message: `Call tools in parallel: ${Object.keys(CHILDREN).join(", ")}`,
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
    { signal: AbortSignal.timeout(DELEGATED_TURN_BUDGET_MS) },
  );
  assert.ok(stream.ok && stream.body, `session stream failed (${stream.status})`);
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  // The delegated children run inside the root turn, so the read runs until
  // the root turn settles after every child has settled (see delegated-turn.ts).
  const watch = watchDelegatedTurn();
  const children = new Map<ChildName, string>();
  const deadline = Date.now() + DELEGATED_TURN_BUDGET_MS;
  let buffer = "";
  const seen: string[] = [];
  while (!watch.settled && Date.now() < deadline) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      for (const event of sessionStreamLineEvents(JSON.parse(line))) {
        if (event.type) seen.push(event.type);
        watch.observe(event);
        const opened = childOpened(event);
        if (opened) children.set(opened.name, opened.sessionId);
      }
    }
  }
  await reader.cancel().catch(() => undefined);
  assert.ok(!watch.turnFailed, `root turn failed; stream events=${seen.join(", ")}`);
  assert.ok(watch.turnCompleted, `root turn did not complete; stream events=${seen.join(", ")}`);
  assert.deepEqual(
    [...children.keys()].sort(),
    Object.keys(CHILDREN).sort(),
    `root did not open every child; stream events=${seen.join(", ")}`,
  );
  return { eveSessionId: sessionId, children };
}

function childOpened(event: {
  type?: string;
  data?: unknown;
}): { name: ChildName; sessionId: string } | null {
  if (event.type !== "child.opened" || !event.data || typeof event.data !== "object") return null;
  const { name, sessionId } = event.data as { name?: unknown; sessionId?: unknown };
  return typeof name === "string" && name in CHILDREN && typeof sessionId === "string"
    ? { name: name as ChildName, sessionId }
    : null;
}

/**
 * Builds the probe Extension with the workspace's eve and vendors it into the
 * fixture as a `file:` directory dependency, mounted at `probe`. Source
 * import records text files only, and the built package is text.
 */
async function mountProbeExtension(workDir: string, sourcePath: string): Promise<void> {
  const extensionDir = path.join(workDir, "probe-extension");
  await cp(EXTENSION_TEMPLATE_PATH, extensionDir, { recursive: true });
  const manifest = {
    name: EXTENSION_PACKAGE,
    version: "0.0.0",
    private: true,
    type: "module",
    eve: { extension: { source: "./extension", dist: "./dist/extension" } },
    files: ["dist"],
    peerDependencies: { eve: "*" },
  };
  await writeFile(path.join(extensionDir, "package.json"), `${JSON.stringify(manifest)}\n`);
  await mkdir(path.join(extensionDir, "node_modules"));
  await symlink(EVE_PACKAGE_PATH, path.join(extensionDir, "node_modules/eve"), "dir");
  await execFileAsync(
    process.execPath,
    [path.join(EVE_PACKAGE_PATH, "bin/eve.js"), "extension", "build"],
    { cwd: extensionDir, env: { ...process.env, EVE_TELEMETRY_DISABLED: "1" } },
  );

  const vendored = path.join(sourcePath, EXTENSION_PACKAGE);
  await mkdir(vendored);
  await cp(path.join(extensionDir, "package.json"), path.join(vendored, "package.json"));
  await cp(path.join(extensionDir, "dist"), path.join(vendored, "dist"), { recursive: true });
  await mkdir(path.join(sourcePath, "agent/extensions"), { recursive: true });
  await writeFile(
    path.join(sourcePath, "agent/extensions/probe.ts"),
    `export { default } from "${EXTENSION_PACKAGE}";\n`,
  );
  const packagePath = path.join(sourcePath, "package.json");
  const fixturePackage = JSON.parse(await readFile(packagePath, "utf8")) as {
    dependencies: Record<string, string>;
  };
  fixturePackage.dependencies[EXTENSION_PACKAGE] = `file:./${EXTENSION_PACKAGE}`;
  await writeFile(packagePath, `${JSON.stringify(fixturePackage, null, 2)}\n`);
}
