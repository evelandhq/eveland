import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http, { type IncomingMessage } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { serve } from "../../apps/gateway/node_modules/@hono/node-server/dist/index.mjs";
import { encryptSecretValue } from "../../packages/core/src/server/secrets.js";
import { createStoreFromEnv } from "../../packages/db/src/store-factory.js";
import { createGatewayApp } from "../../apps/gateway/src/app.js";
import { processNextJob } from "../../apps/worker/src/jobs/process.js";
import { createRuntimeAdapterFromEnv } from "../../apps/worker/src/runtime/select.js";

const APP_SECRET_KEY = process.env.APP_SECRET_KEY ?? "eveland-dev-secret-key-000000000";
const FIXTURE = fileURLToPath(new URL("../../apps/worker/src/integration/fixtures/observer-e2e", import.meta.url));
const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const { store, close } = createStoreFromEnv();
  const runtime = createRuntimeAdapterFromEnv();
  const project = await store.createProject({ name: `Gateway E2E ${Date.now()}`, importKind: "zip", sourcePath: FIXTURE });
  await store.upsertSecret(project.id, "EVE_MOCK_AUTHORED_MODELS", JSON.stringify(encryptSecretValue("1", APP_SECRET_KEY)));
  let processName: string | null = null;
  let server: ReturnType<typeof serve> | null = null;
  try {
    assert.equal(await processNextJob(store, "gateway-e2e", { appSecretKey: APP_SECRET_KEY }), true);
    await store.enqueueJob(project.id, "build_deploy");
    assert.equal(await processNextJob(store, "gateway-e2e", { appSecretKey: APP_SECRET_KEY }), true);
    const deployment = await store.getCurrentDeployment(project.id);
    assert.ok(deployment);
    processName = deployment.containerName;

    const app = createGatewayApp(store, {
      allowedBaseDomains: ["agent.localhost", "agents.example.com"],
      internalServiceToken: "gateway-e2e-secret",
      routeCacheTtlMs: 60_000,
    });
    server = serve({ fetch: app.fetch, port: 0 });
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Gateway E2E server did not bind.");
    const gatewayPort = address.port;
    const localHost = `${project.routingKey}.agent.localhost:4080`;
    const previewRoute = (await store.listProjectRoutes(project.id)).find((route) => route.kind === "deployment");
    assert.ok(previewRoute);
    const previewHealth = await gatewayRequest(gatewayPort, {
      host: `${previewRoute.hostname}:4080`,
      path: "/eve/v1/health",
      method: "GET",
    });
    assert.equal(previewHealth.statusCode, 200, `immutable preview route failed: ${previewHealth.body}`);

    const created = await gatewayRequest(gatewayPort, {
      host: localHost,
      path: "/eve/v1/session",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Ask the researcher to verify Gateway streaming." }),
    });
    assert.equal(created.statusCode, 202, `*.localhost should receive Eve localDev access: ${created.body}`);
    const createdBody = JSON.parse(created.body) as { sessionId?: string };
    const eveSessionId = created.headers["x-eve-session-id"]?.toString() ?? createdBody.sessionId;
    assert.ok(eveSessionId);
    const streamed = await gatewayStream(gatewayPort, localHost, eveSessionId);
    assert.ok(streamed.firstChunkMs < streamed.completedMs, `first NDJSON chunk was buffered: ${JSON.stringify(streamed)}`);
    await expectBinding(store, project.id, eveSessionId, deployment.id);

    const dockerPort = runtime.name === "docker" ? await execFileAsync("docker", ["port", processName!]) : null;
    if (dockerPort) assert.match(dockerPort.stdout, /-> 127\.0\.0\.1:/m, `Agent port was publicly bound: ${dockerPort.stdout}`);

    await store.reconcileAgentRoutes("agents.example.com");
    const productionRoute = await store.findProjectRoute(project.id);
    assert.ok(productionRoute);
    const production = await gatewayRequest(gatewayPort, {
      host: productionRoute.hostname,
      path: "/eve/v1/session",
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-host": "localhost", forwarded: "host=localhost" },
      body: JSON.stringify({ message: "must remain unauthorized" }),
    });
    assert.equal(production.statusCode, 401, `production Host spoofing reached Eve localDev: ${production.body}`);

    console.log(
      `GATEWAY E2E OK runtime=${runtime.name} preview=200 localDev=202 production=401 firstChunkMs=${streamed.firstChunkMs} completedMs=${streamed.completedMs}`,
    );
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (processName) await runtime.stopProcess(processName).catch(() => undefined);
    await close();
  }
}

async function expectBinding(store: ReturnType<typeof createStoreFromEnv>["store"], projectId: string, eveSessionId: string, deploymentId: string) {
  const binding = await store.findSessionBinding(projectId, eveSessionId);
  assert.equal(binding?.deploymentId, deploymentId);
  assert.equal(binding?.trigger, "api");
  assert.match(binding?.remoteIp ?? "", /127\.0\.0\.1|::ffff:127\.0\.0\.1/);
  assert.ok(binding?.requestId);
}

function gatewayRequest(
  port: number,
  input: { host: string; path: string; method: string; headers?: Record<string, string>; body?: string },
): Promise<{ statusCode: number; headers: IncomingMessage["headers"]; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { hostname: "127.0.0.1", port, path: input.path, method: input.method, headers: { host: input.host, ...input.headers } },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, headers: response.headers, body }));
      },
    );
    request.once("error", reject);
    request.end(input.body);
  });
}

function gatewayStream(port: number, host: string, sessionId: string): Promise<{ firstChunkMs: number; completedMs: number }> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const request = http.request(
      { hostname: "127.0.0.1", port, path: `/eve/v1/session/${encodeURIComponent(sessionId)}/stream`, headers: { host } },
      (response) => {
        let raw = "";
        let firstChunkMs: number | null = null;
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          firstChunkMs ??= Date.now() - startedAt;
          raw += chunk;
          if (raw.includes('"type":"turn.completed"')) {
            const completedMs = Date.now() - startedAt;
            response.destroy();
            resolve({ firstChunkMs, completedMs });
          }
        });
        response.on("end", () => {
          if (!raw.includes('"type":"turn.completed"')) reject(new Error(`Gateway stream ended before turn.completed: ${raw}`));
        });
      },
    );
    request.setTimeout(30_000, () => request.destroy(new Error("Gateway stream timed out.")));
    request.once("error", reject);
    request.end();
  });
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
