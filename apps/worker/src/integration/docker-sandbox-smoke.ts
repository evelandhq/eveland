// Real local-Docker sandbox smoke. Builds the Eve fixture through the same
// RuntimeAdapter used by jobs, including release preparation, sandbox
// injection, image build, and the deployment-permission TypeScript probe.
//
// Run from the repository root:
//   pnpm --filter @eveland/worker smoke:docker-sandbox

import assert from "node:assert/strict";
import { glob, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { allocateAvailableHostPort } from "../jobs/process.js";
import { createDockerAdapter } from "../runtime/docker.js";
import { waitForHttpHealth } from "../runtime/health.js";
import { writeAgentRuntimePolicy } from "../runtime/observability-policy.js";
import { resolveBackendDistDir } from "../runtime/select.js";
import { processSafeName } from "../runtime/types.js";

const projectId = "proj_localts";
const releaseId = "rel_" + Date.now().toString(36);
const imageTag = "eveland/" + processSafeName(projectId) + ":" + processSafeName(releaseId);
const processName = "eveland-local-sandbox-smoke-" + Date.now().toString(36);
const root = await mkdtemp(path.join(os.tmpdir(), "eveland-local-sandbox-smoke-"));
const sandboxCacheDir = path.join(root, "sandbox");
const observabilityPolicyDir = path.join(root, "observability");
const adapter = createDockerAdapter({ internalPort: 3000, backendDistDir: resolveBackendDistDir });
let started = false;

async function runTypeScriptTurn(hostPort: number): Promise<void> {
  const command =
    'test "$(cat eveland-seed.txt)" = "eveland-seed-preserved" && ' +
    "printf 'const message: string = \"http-typescript-ok\"; console.log(message)\\n' > hello.ts && " +
    "node hello.ts > http-turn-marker.txt";
  const quote = String.fromCharCode(96);
  const createResponse = await fetch("http://127.0.0.1:" + hostPort + "/eve/v1/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Use the bash tool to run the command " + quote + command + quote + "." }),
    signal: AbortSignal.timeout(10_000),
  });
  const createBody = await createResponse.text();
  assert.equal(createResponse.ok, true, "session create failed: " + createBody);
  const parsed = JSON.parse(createBody) as { sessionId?: unknown };
  const sessionId =
    typeof parsed.sessionId === "string" ? parsed.sessionId : (createResponse.headers.get("x-eve-session-id") ?? undefined);
  assert.equal(typeof sessionId, "string", "session create returned no sessionId");

  const streamResponse = await fetch(
    "http://127.0.0.1:" + hostPort + "/eve/v1/session/" + encodeURIComponent(sessionId as string) + "/stream",
    { signal: AbortSignal.timeout(30_000) },
  );
  assert.equal(streamResponse.ok, true, "session stream failed with status " + streamResponse.status);
  assert.ok(streamResponse.body);

  const reader = streamResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let completed = false;
  while (!completed) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as { type?: unknown };
      assert.notEqual(event.type, "turn.failed", "the live sandbox turn failed");
      if (event.type === "turn.completed" || event.type === "session.completed") {
        completed = true;
        break;
      }
    }
  }
  await reader.cancel();
  assert.equal(completed, true, "the live sandbox turn never completed");

  let markerPath: string | undefined;
  for await (const match of glob("**/http-turn-marker.txt", { cwd: sandboxCacheDir })) {
    markerPath = path.join(sandboxCacheDir, match);
    break;
  }
  assert.ok(markerPath, "the live bash tool did not create its TypeScript marker");
  assert.equal((await readFile(markerPath, "utf8")).trim(), "http-typescript-ok");
}

try {
  await Promise.all([
    mkdir(sandboxCacheDir, { recursive: true }),
    writeAgentRuntimePolicy({
      directory: observabilityPolicyDir,
      policy: {
        schemaVersion: 1,
        revision: 1,
        capture: {
          enabled: false,
          sampleRatio: 1,
          recordInputs: false,
          recordOutputs: false,
          includeReasoning: false,
        },
        otlp: { endpoint: "http://eveland-otel-collector:4328" },
        deploymentCredential: "credential.signature",
        resource: {
          teamId: "team_default",
          projectId,
          releaseId,
          deploymentId: "dep_local",
          runtimeKind: "docker",
          environment: "development",
        },
      },
    }),
  ]);
  const result = await adapter.buildRelease({
    projectId,
    releaseId,
    sourcePath: path.resolve(import.meta.dirname, "fixtures/agent-sandbox-e2e"),
    buildDir: path.join(root, "release"),
    commandContext: { isEveProject: true, hasLockfile: false, scripts: {} },
  });

  assert.equal(result.releaseRef, imageTag);
  assert.match(result.log, /Injected eve sandbox modules: agent\/sandbox\/sandbox\.js/);
  assert.equal(
    await readFile(path.join(root, "release", "agent", "sandbox", "workspace", "eveland-seed.txt"), "utf8"),
    "eveland-seed-preserved\n",
  );
  assert.match(result.log, /Docker sandbox self-check passed/);
  const hostPort = await allocateAvailableHostPort();
  await adapter.startProcess({
    processName,
    releaseRef: result.releaseRef,
    port: hostPort,
    env: { EVE_MOCK_AUTHORED_MODELS: "1", NODE_ENV: "development" },
    commandContext: { isEveProject: true, hasLockfile: false, scripts: {} },
    sandboxCacheDir,
    observabilityPolicyDir,
  });
  started = true;
  await waitForHttpHealth({ host: "127.0.0.1", port: hostPort, timeoutMs: 30_000 });
  await runTypeScriptTurn(hostPort);
  console.log("DOCKER TYPESCRIPT SANDBOX SMOKE OK");
} finally {
  if (started) await adapter.stopProcess(processName).catch(() => {});
  await adapter.removeRelease?.(imageTag).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
