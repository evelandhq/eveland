import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http, { type IncomingMessage } from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GATEWAY_PORT } from "../../packages/core/src/ports.js";
import { promisify } from "node:util";
import { serve } from "../../apps/gateway/node_modules/@hono/node-server/dist/index.mjs";
import { sealSecret } from "../../packages/core/src/server/sealed-secret.js";
import { materializeEveFixtureDirectory } from "../../packages/core/src/server/eve-fixture.js";
import { affinityBucketForRoute } from "../../packages/core/src/routing.js";
import { createPgliteTestStore } from "../../packages/db/src/test-store.js";
import { createGatewayApp } from "../../apps/gateway/src/app.js";
import { signAffinityCookie } from "../../apps/gateway/src/gateway-routing.js";
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
    // Turns execute only via the external dispatcher.
    let workflowRuntime: WorkflowRuntime | null = null;
    workflowRuntime = await startWorkflowRuntime(store);
    let runtime: ReturnType<typeof createRuntimeAdapterFromEnv> | null = null;
    const processNames: string[] = [];
    let server: ReturnType<typeof serve> | null = null;
    const probe = await startProbe();
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
        sealSecret("1", APP_SECRET_KEY, "project-secret"),
      );
      // Where the fixture's thread and A2A channels report which Deployment
      // handled a request or ran a turn.
      await store.upsertSecret(
        project.id,
        "CHANNEL_PROBE_URL",
        sealSecret(probe.url, APP_SECRET_KEY, "project-secret"),
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
      const localHost = `${project.slug}.agent.localhost:${GATEWAY_PORT}`;
      const previewRoutes = (await store.listProjectRoutes(project.id)).filter(
        (route) => route.kind === "deployment",
      );
      assert.equal(previewRoutes.length, 2);
      const previewRoute = previewRoutes.find(
        (route) => route.targets[0]?.deploymentId === deployment.id,
      );
      assert.ok(previewRoute);
      const previewHealth = await gatewayRequest(gatewayPort, {
        host: `${previewRoute.hostname}:${GATEWAY_PORT}`,
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
      // The Gateway keys weighted routing by its signed affinity cookie.
      const affinityCookie = `eveland_affinity=${encodeURIComponent(
        signAffinityCookie(candidateAffinity, "gateway-e2e-affinity-secret"),
      )}`;
      const created = await gatewayRequest(gatewayPort, {
        host: localHost,
        path: "/eve/v1/session",
        method: "POST",
        headers: { "content-type": "application/json", cookie: affinityCookie },
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
        headers: { "content-type": "application/json", cookie: affinityCookie },
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
        headers: { "content-type": "application/json", cookie: affinityCookie },
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

      // eve answers the create with 202 as soon as the shared World has
      // accepted the run, before the dispatcher has activated the Deployment
      // and the first turn has started; a cancel that races that window is a
      // legitimate `no_active_turn`. Attach to the durable stream and wait for
      // the turn to exist before proving the bound cancel is routed.
      await gatewayWaitForEvent(gatewayPort, localHost, cancellableSessionId, "turn.started");
      const cancelled = await gatewayRequest(gatewayPort, {
        host: localHost,
        path: `/eve/v1/session/${encodeURIComponent(cancellableSessionId)}/cancel`,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(cancelled.statusCode, 202, `bound cancel failed: ${cancelled.body}`);
      const cancelledBody = JSON.parse(cancelled.body) as {
        sessionId?: string;
        ok?: boolean;
        deliveryId?: string;
      };
      assert.equal(cancelledBody.sessionId, cancellableSessionId);
      // eve admits the cancel as a delivery and answers
      // `{ ok: true, sessionId, deliveryId }`.
      assert.ok(
        cancelledBody.ok === true && typeof cancelledBody.deliveryId === "string",
        `unexpected cancel answer: ${cancelled.body}`,
      );
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

      // A channel conversation under a two-target route: a channel route
      // carries no session id, so each message follows the weights, and the
      // turn it continues runs on the Deployment that received it. The
      // conversation itself carries on across the two Releases.
      await store.updateDeploymentStatus(deployment.id, "running");
      await store.updateDeploymentStatus(candidate.id, "running");
      await store.updateRouteTargets(stableBeforeSplit.id, [
        { deploymentId: deployment.id, weight: 5_000, variantName: "control" },
        { deploymentId: candidate.id, weight: 5_000, variantName: "candidate" },
      ]);
      await invalidateGateway(gatewayPort, localHost);
      const split = await store.findProjectRoute(project.id);
      assert.ok(split);
      const cookieFor = (target: "control" | "candidate") => {
        const key = Array.from({ length: 10_000 }, (_, index) => `thread-${index}`).find(
          (candidateKey) =>
            affinityBucketForRoute(split.id, split.policyRevision, candidateKey) < 5_000 ===
            (target === "control"),
        );
        assert.ok(key);
        return `eveland_affinity=${encodeURIComponent(signAffinityCookie(key, "gateway-e2e-affinity-secret"))}`;
      };
      const threadPath = `/threads/gateway-e2e-${Date.now()}/messages`;
      const first = await threadMessage(gatewayPort, localHost, threadPath, cookieFor("control"));
      assert.equal(first.handledBy, deployment.id, "first channel message took the wrong target");
      // The fixture's hook runs inside each turn and reports where it ran.
      const turnSettled = (after?: ProbeFact) =>
        probe.waitFor(
          (fact) =>
            fact.kind === "hook.turn.settled" &&
            fact.sessionId === first.sessionId &&
            fact !== after,
        );
      const firstTurn = await turnSettled();
      assert.equal(firstTurn.deploymentId, deployment.id);
      const second = await threadMessage(
        gatewayPort,
        localHost,
        threadPath,
        cookieFor("candidate"),
      );
      assert.equal(second.handledBy, candidate.id, "second channel message took the wrong target");
      assert.equal(second.sessionId, first.sessionId, "the thread did not continue its session");
      const secondTurn = await turnSettled(firstTurn);
      assert.equal(
        secondTurn.deploymentId,
        candidate.id,
        "a channel turn did not run on the Deployment that received its event",
      );

      // A2A from a client that keeps no cookies: the context and its tasks
      // stay on the Deployment that answered the first send, after the other
      // Deployment is promoted.
      const a2aStart = await a2aCall(gatewayPort, localHost, "a2a-start", "SendMessage", {
        message: {
          messageId: `gateway-e2e-${Date.now()}`,
          role: "ROLE_USER",
          parts: [{ text: "Reply briefly." }],
        },
      });
      const startTask = (a2aStart as { task?: { id?: string; contextId?: string } }).task;
      assert.ok(
        startTask?.id && startTask.contextId,
        `A2A send returned no task: ${JSON.stringify(a2aStart)}`,
      );
      const owner = (await probe.waitFor((fact) => fact.probe === "a2a-start")).deploymentId;
      assert.equal(
        (await store.findSessionBinding(project.id, startTask.contextId))?.deploymentId,
        owner,
      );
      const other = owner === deployment.id ? candidate.id : deployment.id;
      await store.promoteDeployment(project.id, other);
      await invalidateGateway(gatewayPort, localHost);
      const a2aContinue = await a2aCall(gatewayPort, localHost, "a2a-continue", "SendMessage", {
        message: {
          messageId: `gateway-e2e-continue-${Date.now()}`,
          role: "ROLE_USER",
          contextId: startTask.contextId,
          parts: [{ text: "Reply briefly again." }],
        },
      });
      const continueTask = (a2aContinue as { task?: { id?: string; contextId?: string } }).task;
      assert.equal(continueTask?.contextId, startTask.contextId, JSON.stringify(a2aContinue));
      assert.equal(
        (await probe.waitFor((fact) => fact.probe === "a2a-continue")).deploymentId,
        owner,
        "an A2A send naming its context left the Deployment that started it after promote",
      );
      await a2aCall(gatewayPort, localHost, "a2a-get", "GetTask", { id: continueTask!.id });
      assert.equal(
        (await probe.waitFor((fact) => fact.probe === "a2a-get")).deploymentId,
        owner,
        "A2A GetTask left the Deployment that started its context after promote",
      );
      await store.promoteDeployment(project.id, deployment.id);
      await invalidateGateway(gatewayPort, localHost);

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

      // eve's localDev() ignores the request Host, so a Host spoof cannot fool
      // anything downstream and a 401 here would prove nothing about forwarding
      // headers. That invariant lives in the Gateway and is asserted there --
      // apps/gateway/src/app.test.ts drives a real upstream that echoes its
      // received headers and checks the Agent is never handed a loopback
      // authority, nor client-supplied forwarding headers. What is worth proving
      // end to end is that a non-localhost production Host routes at all.
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
        `GATEWAY E2E OK runtime=${runtime.name} concurrent=2 split=90/10-to-50/50 zeroWeight=1 pinned=1 cancel=delivered promoted=1 rolledBack=1 channelAcrossReleases=1 a2aPinned=1 preview=200 create=202 production=202 firstChunkMs=${streamed.firstChunkMs} completedMs=${streamed.completedMs}`,
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
      await probe.close();
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
  assert.equal(binding?.affinitySource, "cookie");
  assert.match(binding?.remoteIp ?? "", /127\.0\.0\.1|::ffff:127\.0\.0\.1/);
  assert.ok(binding?.requestId);
}

type ProbeFact = {
  kind?: string;
  probe?: string;
  sessionId?: string;
  deploymentId?: string;
};

/** Collects what the fixture's channels report about where they ran. */
async function startProbe(): Promise<{
  url: string;
  waitFor: (matches: (fact: ProbeFact) => boolean) => Promise<ProbeFact>;
  close: () => Promise<void>;
}> {
  const facts: ProbeFact[] = [];
  const probeServer = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      try {
        facts.push(JSON.parse(body) as ProbeFact);
      } catch {
        // Not a fact; ignore it.
      }
      response.statusCode = 204;
      response.end();
    });
  });
  probeServer.listen(0, "127.0.0.1");
  await once(probeServer, "listening");
  const { port } = probeServer.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/probe`,
    waitFor: async (matches) => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const found = facts.find(matches);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(`probe fact never arrived; facts=${JSON.stringify(facts)}`);
    },
    close: () => new Promise<void>((resolve) => probeServer.close(() => resolve())),
  };
}

async function threadMessage(
  port: number,
  host: string,
  path: string,
  cookie: string,
): Promise<{ sessionId: string; handledBy: string }> {
  const response = await gatewayRequest(port, {
    host,
    path,
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ message: "Reply to the thread." }),
  });
  assert.equal(response.statusCode, 202, `channel message failed: ${response.body}`);
  const parsed = JSON.parse(response.body) as { sessionId?: unknown; handledBy?: unknown };
  assert.ok(
    typeof parsed.sessionId === "string" && typeof parsed.handledBy === "string",
    `channel message answered without its session or Deployment: ${response.body}`,
  );
  return { sessionId: parsed.sessionId, handledBy: parsed.handledBy };
}

/** One A2A JSON-RPC call, as a client without cookies sends it. */
async function a2aCall(
  port: number,
  host: string,
  probe: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const response = await gatewayRequest(port, {
    host,
    path: "/eve/v1/a2a",
    method: "POST",
    headers: { "content-type": "application/json", "a2a-version": "1.0", "x-a2a-probe": probe },
    body: JSON.stringify({ jsonrpc: "2.0", id: probe, method, params }),
  });
  assert.equal(response.statusCode, 200, `A2A ${method} failed: ${response.body}`);
  const parsed = JSON.parse(response.body) as { result?: unknown; error?: unknown };
  assert.ok(parsed.result, `A2A ${method} answered an error: ${response.body}`);
  return parsed.result;
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

function gatewayWaitForEvent(
  port: number,
  host: string,
  sessionId: string,
  type: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const marker = `"type":"${type}"`;
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: `/eve/v1/session/${encodeURIComponent(sessionId)}/stream`,
        headers: { host },
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          raw += chunk;
          if (raw.includes(marker)) {
            response.destroy();
            resolve();
          }
        });
        response.on("end", () => {
          if (!raw.includes(marker))
            reject(new Error(`Gateway stream ended before ${type}: ${raw}`));
        });
      },
    );
    request.setTimeout(60_000, () =>
      request.destroy(new Error(`Gateway stream produced no ${type} within 60s.`)),
    );
    request.once("error", reject);
    request.end();
  });
}

// eve ends a turn with one `turn.settled` fact inside a commit line.
const turnSettled = /"type":"turn\.settled"/;

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
          if (turnSettled.test(raw)) {
            const completedMs = Date.now() - startedAt;
            response.destroy();
            resolve({ firstChunkMs, completedMs });
          }
        });
        response.on("end", () => {
          if (!turnSettled.test(raw))
            reject(new Error(`Gateway stream ended before the turn settled: ${raw}`));
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
