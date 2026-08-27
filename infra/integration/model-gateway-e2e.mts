import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "../../apps/model-gateway/node_modules/@hono/node-server/dist/index.mjs";
import { materializeEveFixtureDirectory } from "../../packages/core/src/server/eve-fixture.js";
import { createPgliteTestStore } from "../../packages/db/src/test-store.js";
import { createModelGatewayApp } from "../../apps/model-gateway/src/app.js";
import { createInstanceTokenAuthenticator } from "../../apps/model-gateway/src/instance-token-auth.js";
import { createStaticModelRegistry } from "../../apps/model-gateway/src/registry.js";
import { processNextJob } from "../../apps/worker/src/jobs/process.js";
import { createRuntimeAdapterFromEnv } from "../../apps/worker/src/runtime/select.js";
import { startWorkflowRuntime, type WorkflowRuntime } from "./workflow-runtime.mts";

/**
 * Model Gateway end-to-end: a fixture agent whose whole model config is the
 * bare string "zai/glm-5.3-flash" runs a REAL turn through the real
 * import -> build -> deploy pipeline. No EVE_MOCK_AUTHORED_MODELS: the turn's
 * model call must leave the deployment, authenticate against the in-process
 * Eveland Model Gateway with the instance-bound AI_GATEWAY_API_KEY the Worker
 * minted, and be replayed to a mock OpenAI-compatible upstream with the BYOK
 * provider key that only the gateway holds.
 *
 * Proofs:
 *  - turn.completed with the upstream's text (zero agent-side provider code)
 *  - upstream saw "Bearer sk-e2e-zai" and providerModelId "glm-5.3-flash"
 *  - the emg_ runtime token never reached the upstream provider
 *  - the BYOK provider key never entered the deployment environment
 *  - revocation: instance leaves the live statuses -> next request is 401
 */
const APP_SECRET_KEY = process.env.APP_SECRET_KEY ?? "eveland-dev-secret-key-000000000";
const FIXTURE_TEMPLATE = fileURLToPath(new URL("./fixtures/model-gateway", import.meta.url));
const PROVIDER_KEY = "sk-e2e-zai";

type SessionEvent = { type: string } & Record<string, unknown>;

type UpstreamRecording = {
  requests: Array<{ headers: IncomingMessage["headers"]; body: { model?: string } }>;
};

async function main(): Promise<void> {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "eveland-model-gateway-e2e-"));
  const servers: Server[] = [];
  let gatewayServer: ReturnType<typeof serve> | null = null;
  let workflowRuntime: WorkflowRuntime | null = null;
  let closeStore: (() => Promise<void>) | null = null;
  let runtime: ReturnType<typeof createRuntimeAdapterFromEnv> | null = null;
  const processNames: string[] = [];
  try {
    const fixtureSourcePath = path.join(fixtureRoot, "source");
    await materializeEveFixtureDirectory(FIXTURE_TEMPLATE, fixtureSourcePath);
    const { store, close } = await createPgliteTestStore();
    closeStore = close;
    workflowRuntime = await startWorkflowRuntime(store);
    runtime = createRuntimeAdapterFromEnv();

    // Deployment-facing host of platform services (Docker's host.docker.internal split).
    const bindHost = runtime.name === "docker" ? "0.0.0.0" : "127.0.0.1";
    const deploymentFacingHost = runtime.name === "docker" ? "host.docker.internal" : "127.0.0.1";

    const { origin: upstreamOrigin, recording } = await startMockOpenAiUpstream(bindHost, servers);
    const registry = createStaticModelRegistry(
      [{ id: "zai", baseURL: `${upstreamOrigin}/v1`, apiKey: PROVIDER_KEY }],
      [{ modelId: "zai/glm-5.3-flash", connectionId: "zai", providerModelId: "glm-5.3-flash" }],
    );
    const gatewayApp = createModelGatewayApp({
      authenticate: createInstanceTokenAuthenticator(store),
      resolveModel: (modelId) => registry.resolveModel(modelId),
      listModels: () => registry.listModels(),
    });
    gatewayServer = serve({ fetch: gatewayApp.fetch, port: 0, hostname: bindHost });
    await new Promise<void>((resolve) => gatewayServer!.on("listening", () => resolve()));
    const gatewayPort = (gatewayServer.address() as AddressInfo).port;
    const gatewayLocalOrigin = `http://127.0.0.1:${gatewayPort}`;
    process.env.EVELAND_MODEL_GATEWAY_URL = `http://${deploymentFacingHost}:${gatewayPort}`;

    const project = await store.createProject({
      name: `Model Gateway E2E ${Date.now()}`,
      importKind: "zip",
      sourcePath: fixtureSourcePath,
    });
    const processOptions = { appSecretKey: APP_SECRET_KEY, runtime };
    assert.equal(
      await processNextJob(store, "model-gateway-e2e", processOptions),
      true,
      "import_source job did not run",
    );
    assert.equal((await store.getProject(project.id))?.status, "imported", "fixture import failed");
    await store.enqueueJob(project.id, "build_deploy");
    assert.equal(
      await processNextJob(store, "model-gateway-e2e", processOptions),
      true,
      "build_deploy job did not run",
    );
    const deployment = await store.getCurrentDeployment(project.id);
    assert.ok(deployment, "no current deployment after build_deploy");
    processNames.push(deployment.containerName);

    // The BYOK provider key must never enter the deployment environment; the
    // 0600 env file is the runtime env authority for both adapters.
    const dataDir = path.resolve(process.env.EVELAND_DATA_DIR ?? ".eveland-data");
    const envFilePath = path.join(dataDir, "deployment-env", `${deployment.containerName}.env`);
    const deploymentEnv = await readFile(envFilePath, "utf8");
    assert.ok(
      !deploymentEnv.includes(PROVIDER_KEY),
      "BYOK provider key leaked into deployment env",
    );
    assert.match(
      deploymentEnv,
      /AI_GATEWAY_API_KEY=["']?emg_/,
      "instance-bound runtime token missing from deployment env",
    );
    const runtimeToken = /AI_GATEWAY_API_KEY=["']?(emg_[A-Za-z0-9_-]+)/.exec(deploymentEnv)?.[1];
    assert.ok(runtimeToken, "could not extract the runtime token for the revocation proof");

    // The real turn: the agent's bare string model resolves through the
    // injected hook runtime to the Eveland Model Gateway.
    const events = await runTurn(deployment.hostPort, "Say hello.");
    assert.ok(
      events.some((event) => event.type === "turn.completed"),
      `turn never completed: ${JSON.stringify(events.map((event) => event.type))}`,
    );
    const eventText = JSON.stringify(events);
    assert.ok(
      eventText.includes("upstream stream"),
      "the upstream's streamed text never reached the session",
    );

    assert.ok(recording.requests.length >= 1, "mock upstream received no request");
    for (const request of recording.requests) {
      assert.equal(
        request.headers.authorization,
        `Bearer ${PROVIDER_KEY}`,
        "upstream did not receive the BYOK provider key",
      );
      assert.equal(request.body.model, "glm-5.3-flash", "provider model id was not routed");
      assert.ok(
        !JSON.stringify(request.headers).includes("emg_"),
        "the runtime token leaked to the upstream provider",
      );
    }

    // Revocation: the token is bound to the RuntimeInstance; leaving the live
    // statuses revokes it with no extra bookkeeping.
    const authedProbe = await probeGateway(gatewayLocalOrigin, runtimeToken);
    assert.notEqual(authedProbe, 401, "live instance token was rejected");
    for (const instance of await store.listDeploymentRuntimeInstances(deployment.id)) {
      if (["starting", "ready", "draining"].includes(instance.status)) {
        await store.updateRuntimeInstance(instance.id, {
          status: "stopped",
          endpointHost: null,
          endpointPort: null,
        });
      }
    }
    const revokedProbe = await probeGateway(gatewayLocalOrigin, runtimeToken);
    assert.equal(revokedProbe, 401, "revoked instance token still authenticates");

    console.log(
      `MODEL GATEWAY E2E OK runtime=${runtime.name} turn=completed byok=gateway-only revoke=401 upstreamRequests=${recording.requests.length}`,
    );
  } finally {
    if (runtime) {
      for (const processName of processNames) {
        await runtime.stopProcess(processName).catch(() => undefined);
      }
    }
    if (gatewayServer) {
      await new Promise<void>((resolve) => gatewayServer!.close(() => resolve()));
    }
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    if (workflowRuntime) await workflowRuntime.stop();
    if (closeStore) await closeStore();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

/** Language-model call with an empty body: 400 when authenticated, 401 when not. */
async function probeGateway(origin: string, token: string): Promise<number> {
  const response = await fetch(`${origin}/v4/ai/language-model`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "ai-language-model-id": "zai/glm-5.3-flash",
      "ai-language-model-specification-version": "4",
      "ai-language-model-streaming": "false",
    },
    body: "{}",
    signal: AbortSignal.timeout(10_000),
  });
  await response.text();
  return response.status;
}

async function runTurn(port: number, message: string): Promise<SessionEvent[]> {
  const created = await fetch(`http://127.0.0.1:${port}/eve/v1/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
    signal: AbortSignal.timeout(30_000),
  });
  const createdBody = await created.text();
  assert.ok(created.ok, `session creation failed (${created.status}): ${createdBody}`);
  const parsed = JSON.parse(createdBody) as { sessionId?: unknown };
  const sessionId =
    typeof parsed.sessionId === "string"
      ? parsed.sessionId
      : created.headers.get("x-eve-session-id");
  assert.ok(sessionId, `session creation returned no session id: ${createdBody}`);

  const response = await fetch(
    `http://127.0.0.1:${port}/eve/v1/session/${encodeURIComponent(sessionId)}/stream?startIndex=0`,
    { signal: AbortSignal.timeout(90_000) },
  );
  assert.ok(response.ok && response.body, `session stream failed (${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: SessionEvent[] = [];
  let buffer = "";
  let waiting = false;
  try {
    while (!waiting) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line) as SessionEvent;
        events.push(event);
        if (event.type === "turn.failed" || event.type === "session.failed") {
          throw new Error(`model gateway turn failed: ${line}`);
        }
        if (event.type === "session.waiting") waiting = true;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  assert.ok(waiting, `session ${sessionId} never reached session.waiting`);
  return events;
}

async function startMockOpenAiUpstream(
  host: string,
  servers: Server[],
): Promise<{ origin: string; recording: UpstreamRecording }> {
  const recording: UpstreamRecording = { requests: [] };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        stream?: boolean;
        model?: string;
      };
      recording.requests.push({ headers: request.headers, body });
      if (body.stream === true) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const frames = [
          { choices: [{ index: 0, delta: { role: "assistant", content: "upstream " } }] },
          { choices: [{ index: 0, delta: { content: "stream" }, finish_reason: "stop" }] },
          { choices: [], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } },
        ];
        for (const frame of frames) {
          response.write(
            `data: ${JSON.stringify({ id: "cmpl-e2e", object: "chat.completion.chunk", created: 1, model: body.model, ...frame })}\n\n`,
          );
        }
        response.write("data: [DONE]\n\n");
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "cmpl-e2e",
          object: "chat.completion",
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "upstream stream" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
        }),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, host, () => resolve()));
  return {
    origin: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${(server.address() as AddressInfo).port}`,
    recording,
  };
}

await main();
