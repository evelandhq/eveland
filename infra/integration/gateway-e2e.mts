import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http, { type IncomingMessage } from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { serve } from "../../apps/gateway/node_modules/@hono/node-server/dist/index.mjs";
import { encryptSecretValue } from "../../packages/core/src/server/secrets.js";
import { materializeEveFixtureDirectory } from "../../packages/core/src/server/eve-fixture.js";
import { affinityBucketForRoute } from "../../packages/core/src/routing.js";
import { createPgliteTestStore } from "../../packages/db/src/test-store.js";
import { createGatewayApp } from "../../apps/gateway/src/app.js";
import { processNextJob } from "../../apps/worker/src/jobs/process.js";
import { createRuntimeAdapterFromEnv } from "../../apps/worker/src/runtime/select.js";
import { startWorkflowRuntime, type WorkflowRuntime } from "./workflow-runtime.mts";

const APP_SECRET_KEY = process.env.APP_SECRET_KEY ?? "eveland-dev-secret-key-000000000";
const FIXTURE_TEMPLATE = fileURLToPath(
  new URL("../../apps/worker/src/integration/fixtures/observer-e2e", import.meta.url),
);
const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "eveland-gateway-e2e-source-"));
  try {
    const fixtureSourcePath = path.join(fixtureRoot, "source");
    await materializeEveFixtureDirectory(FIXTURE_TEMPLATE, fixtureSourcePath);
    const { store, close } = await createPgliteTestStore();
    // Post-cutover: turns execute only via the external dispatcher.
    let workflowRuntime: WorkflowRuntime | null = null;
    workflowRuntime = await startWorkflowRuntime(store);
    let runtime: ReturnType<typeof createRuntimeAdapterFromEnv> | null = null;
    const processNames: string[] = [];
    let server: ReturnType<typeof serve> | null = null;
    try {
      runtime = createRuntimeAdapterFromEnv();
      const project = await store.createProject({
        name: `Gateway E2E ${Date.now()}`,
        importKind: "zip",
        sourcePath: fixtureSourcePath,
      });
      await store.upsertSecret(
        project.id,
        "EVE_MOCK_AUTHORED_MODELS",
        JSON.stringify(encryptSecretValue("1", APP_SECRET_KEY)),
      );
      assert.equal(
        await processNextJob(store, "gateway-e2e", { appSecretKey: APP_SECRET_KEY }),
        true,
      );
      await store.enqueueJob(project.id, "build_deploy");
      assert.equal(
        await processNextJob(store, "gateway-e2e", { appSecretKey: APP_SECRET_KEY }),
        true,
      );
      const deployment = await store.getCurrentDeployment(project.id);
      assert.ok(deployment);
      processNames.push(deployment.containerName);
      await store.enqueueJob(project.id, "build_deploy");
      assert.equal(
        await processNextJob(store, "gateway-e2e", { appSecretKey: APP_SECRET_KEY }),
        true,
      );
      const deployments = await store.listDeployments(project.id);
      assert.equal(deployments.length, 2, "one project should keep two concurrent Deployments");
      const candidate = deployments.find((item) => item.id !== deployment.id);
      assert.ok(candidate);
      processNames.push(candidate.containerName);
      const stableBeforeSplit = await store.findProjectRoute(project.id);
      assert.ok(stableBeforeSplit);
      await store.updateRouteTargets(stableBeforeSplit.id, [
        { deploymentId: deployment.id, weight: 9_000, variantName: "control" },
        { deploymentId: candidate.id, weight: 1_000, variantName: "candidate" },
      ]);

      const app = createGatewayApp(store, {
        allowedBaseDomains: ["agent.localhost", "agents.example.com"],
        affinitySecret: "gateway-e2e-affinity-secret",
        internalServiceToken: "gateway-e2e-secret",
        routeCacheTtlMs: 60_000,
      });
      server = serve({ fetch: app.fetch, port: 0 });
      if (!server.listening) await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Gateway E2E server did not bind.");
      const gatewayPort = address.port;
      const localHost = `${project.slug}.agent.localhost:4080`;
      const previewRoutes = (await store.listProjectRoutes(project.id)).filter(
        (route) => route.kind === "deployment",
      );
      assert.equal(previewRoutes.length, 2);
      const previewRoute = previewRoutes.find(
        (route) => route.targets[0]?.deploymentId === deployment.id,
      );
      assert.ok(previewRoute);
      const previewHealth = await gatewayRequest(gatewayPort, {
        host: `${previewRoute.hostname}:4080`,
        path: "/eve/v1/health",
        method: "GET",
      });
      assert.equal(
        previewHealth.statusCode,
        200,
        `immutable preview route failed: ${previewHealth.body}`,
      );

      const candidateAffinity = Array.from({ length: 10_000 }, (_, index) => `e2e-${index}`).find(
        (key) =>
          affinityBucketForRoute(stableBeforeSplit.id, stableBeforeSplit.policyRevision + 1, key) >=
          9_000,
      );
      assert.ok(candidateAffinity);
      const created = await gatewayRequest(gatewayPort, {
        host: localHost,
        path: "/eve/v1/session",
        method: "POST",
        headers: { "content-type": "application/json", "x-eveland-version-key": candidateAffinity },
        body: JSON.stringify({ message: "Ask the researcher to verify Gateway streaming." }),
      });
      assert.equal(created.statusCode, 202, `session create failed: ${created.body}`);
      const createdBody = JSON.parse(created.body) as { sessionId?: string };
      const eveSessionId = created.headers["x-eve-session-id"]?.toString() ?? createdBody.sessionId;
      assert.ok(eveSessionId);
      await expectBinding(
        store,
        project.id,
        eveSessionId,
        candidate.id,
        `${stableBeforeSplit.id}:r2`,
      );
      const cancellable = await gatewayRequest(gatewayPort, {
        host: localHost,
        path: "/eve/v1/session",
        method: "POST",
        headers: { "content-type": "application/json", "x-eveland-version-key": candidateAffinity },
        body: JSON.stringify({ message: "Start a second turn for cancellation routing." }),
      });
      assert.equal(cancellable.statusCode, 202, `cancellable session failed: ${cancellable.body}`);
      const cancellableBody = JSON.parse(cancellable.body) as { sessionId?: string };
      const cancellableSessionId =
        cancellable.headers["x-eve-session-id"]?.toString() ?? cancellableBody.sessionId;
      assert.ok(cancellableSessionId);
      await expectBinding(
        store,
        project.id,
        cancellableSessionId,
        candidate.id,
        `${stableBeforeSplit.id}:r2`,
      );

      await store.updateRouteTargets(stableBeforeSplit.id, [
        { deploymentId: deployment.id, weight: 5_000, variantName: "control" },
        { deploymentId: candidate.id, weight: 5_000, variantName: "candidate" },
      ]);
      await invalidateGateway(gatewayPort, localHost);
      await expectBinding(
        store,
        project.id,
        eveSessionId,
        candidate.id,
        `${stableBeforeSplit.id}:r2`,
      );

      await store.updateRouteTargets(stableBeforeSplit.id, [
        { deploymentId: deployment.id, weight: 10_000, variantName: "control" },
        { deploymentId: candidate.id, weight: 0, variantName: "candidate" },
      ]);
      await invalidateGateway(gatewayPort, localHost);
      const afterZero = await gatewayRequest(gatewayPort, {
        host: localHost,
        path: "/eve/v1/session",
        method: "POST",
        headers: { "content-type": "application/json", "x-eveland-version-key": candidateAffinity },
        body: JSON.stringify({ message: "Verify zero-weight routing." }),
      });
      assert.equal(
        afterZero.statusCode,
        202,
        `zero-weight replacement session failed: ${afterZero.body}`,
      );
      const afterZeroBody = JSON.parse(afterZero.body) as { sessionId?: string };
      const afterZeroSessionId =
        afterZero.headers["x-eve-session-id"]?.toString() ?? afterZeroBody.sessionId;
      assert.ok(afterZeroSessionId);
      await expectBinding(
        store,
        project.id,
        afterZeroSessionId,
        deployment.id,
        `${stableBeforeSplit.id}:r4`,
      );

      const cancelled = await gatewayRequest(gatewayPort, {
        host: localHost,
        path: `/eve/v1/session/${encodeURIComponent(cancellableSessionId)}/cancel`,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(cancelled.statusCode, 202, `bound cancel failed: ${cancelled.body}`);
      const cancelledBody = JSON.parse(cancelled.body) as { sessionId?: string; status?: string };
      assert.equal(cancelledBody.sessionId, cancellableSessionId);
      assert.ok(["accepted", "no_active_turn"].includes(cancelledBody.status ?? ""));
      await expectBinding(
        store,
        project.id,
        cancellableSessionId,
        candidate.id,
        `${stableBeforeSplit.id}:r2`,
      );

      await store.updateDeploymentStatus(candidate.id, "draining");
      await invalidateGateway(gatewayPort, localHost);
      const streamed = await gatewayStream(gatewayPort, localHost, eveSessionId);
      assert.ok(
        streamed.firstChunkMs < streamed.completedMs,
        `first NDJSON chunk was buffered: ${JSON.stringify(streamed)}`,
      );
      await expectBinding(
        store,
        project.id,
        eveSessionId,
        candidate.id,
        `${stableBeforeSplit.id}:r2`,
      );

      await store.updateDeploymentStatus(candidate.id, "running");
      await store.promoteDeployment(project.id, candidate.id);
      await invalidateGateway(gatewayPort, localHost);
      await store.promoteDeployment(project.id, deployment.id);
      await invalidateGateway(gatewayPort, localHost);
      await assert.doesNotReject(async () => {
        const rolledBack = await store.findProjectRoute(project.id);
        assert.equal(rolledBack?.targets[0]?.deploymentId, deployment.id);
      });

      const dockerPort =
        runtime.name === "docker"
          ? await execFileAsync("docker", ["port", candidate.containerName])
          : null;
      if (dockerPort)
        assert.match(
          dockerPort.stdout,
          /-> 127\.0\.0\.1:/m,
          `Agent port was publicly bound: ${dockerPort.stdout}`,
        );

      // This used to assert 401: the fixture ran localDev(), which authorized on
      // the request Host, so a spoofed `x-forwarded-host: localhost` reaching
      // the Agent would have authenticated and the 401 proved the Gateway had
      // rebuilt the forwarding headers. Eve 0.30's localDev() ignores Host
      // entirely, so nothing downstream can be fooled by a Host spoof any more
      // and the assertion would pass for a reason unrelated to what it guarded.
      //
      // The invariant itself lives in the Gateway, and that is where it is now
      // asserted -- apps/gateway/src/app.test.ts drives a real upstream that
      // echoes its received headers and checks the Agent is never handed a
      // loopback authority, nor client-supplied forwarding headers. What stays
      // worth proving end to end is that a non-localhost production Host routes
      // at all, which the previous shape could not distinguish from a 401.
      await store.reconcileAgentRoutes("agents.example.com");
      const productionRoute = await store.findProjectRoute(project.id);
      assert.ok(productionRoute);
      const production = await gatewayRequest(gatewayPort, {
        host: productionRoute.hostname,
        path: "/eve/v1/session",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-host": "localhost",
          forwarded: "host=localhost",
        },
        body: JSON.stringify({ message: "production Host must route" }),
      });
      assert.equal(production.statusCode, 202, `production Host did not route: ${production.body}`);

      console.log(
        `GATEWAY E2E OK runtime=${runtime.name} concurrent=2 split=90/10-to-50/50 zeroWeight=1 pinned=1 cancel=${cancelledBody.status} promoted=1 rolledBack=1 preview=200 create=202 production=202 firstChunkMs=${streamed.firstChunkMs} completedMs=${streamed.completedMs}`,
      );
    } finally {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      if (runtime) {
        await Promise.all(
          processNames.map((processName) =>
            runtime!.stopProcess(processName).catch(() => undefined),
          ),
        );
      }
      await workflowRuntime?.stop().catch(() => {});
      await close();
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function expectBinding(
  store: Awaited<ReturnType<typeof createPgliteTestStore>>["store"],
  projectId: string,
  eveSessionId: string,
  deploymentId: string,
  experimentId: string,
) {
  const binding = await store.findSessionBinding(projectId, eveSessionId);
  assert.equal(binding?.deploymentId, deploymentId);
  assert.equal(binding?.experimentId, experimentId);
  assert.equal(binding?.trigger, "api");
  assert.equal(binding?.affinitySource, "version_key");
  assert.match(binding?.remoteIp ?? "", /127\.0\.0\.1|::ffff:127\.0\.0\.1/);
  assert.ok(binding?.requestId);
}

async function invalidateGateway(port: number, host: string): Promise<void> {
  const response = await gatewayRequest(port, {
    host: "gateway",
    path: "/internal/cache/invalidate",
    method: "POST",
    headers: { authorization: "Bearer gateway-e2e-secret", "content-type": "application/json" },
    body: JSON.stringify({ hostname: host }),
  });
  assert.equal(response.statusCode, 200, `Gateway invalidation failed: ${response.body}`);
}

function gatewayRequest(
  port: number,
  input: {
    host: string;
    path: string;
    method: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<{ statusCode: number; headers: IncomingMessage["headers"]; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: input.path,
        method: input.method,
        headers: { host: input.host, ...input.headers },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          resolve({ statusCode: response.statusCode ?? 0, headers: response.headers, body }),
        );
      },
    );
    request.once("error", reject);
    request.end(input.body);
  });
}

function gatewayStream(
  port: number,
  host: string,
  sessionId: string,
): Promise<{ firstChunkMs: number; completedMs: number }> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: `/eve/v1/session/${encodeURIComponent(sessionId)}/stream`,
        headers: { host },
      },
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
          if (!raw.includes('"type":"turn.completed"'))
            reject(new Error(`Gateway stream ended before turn.completed: ${raw}`));
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
