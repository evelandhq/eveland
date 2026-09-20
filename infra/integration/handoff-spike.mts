/**
 * SPIKE, not a smoke: does eve's deployment handoff fire on Eveland when a
 * delivery for an idle session is accepted by a Deployment other than the one
 * that owns the session run?
 *
 * One project, two concurrent Deployments A and B built from the same source
 * on the newest eve line, one shared World, the real dispatcher. The session
 * is created on A, left idle, then its SessionBinding is re-pointed at B --
 * standing in for a gateway that routes a session to the promoted Deployment
 * -- and a follow-up message is sent. The World's run rows say what happened.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http, { type IncomingMessage } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GATEWAY_PORT } from "../../packages/core/src/ports.js";
import { serve } from "../../apps/gateway/node_modules/@hono/node-server/dist/index.mjs";
import pg from "../../apps/worker/node_modules/pg/lib/index.js";
import { encryptSecretValue } from "../../packages/core/src/server/secrets.js";
import { materializeEveFixtureDirectory } from "../../packages/core/src/server/eve-fixture.js";
import { createPgliteTestStore } from "../../packages/db/src/test-store.js";
import { createGatewayApp } from "../../apps/gateway/src/app.js";
import { processNextJob } from "../../apps/worker/src/jobs/process.js";
import { createRuntimeAdapterFromEnv } from "../../apps/worker/src/runtime/select.js";
import { startWorkflowRuntime, type WorkflowRuntime } from "./workflow-runtime.mts";

const APP_SECRET_KEY = process.env.APP_SECRET_KEY ?? "eveland-dev-secret-key-000000000";
const FIXTURE_TEMPLATE = fileURLToPath(
  new URL("../../apps/worker/src/integration/fixtures/observer-e2e", import.meta.url),
);
const log = (line: string) => console.log(`[handoff-spike] ${line}`);

async function main(): Promise<void> {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "eveland-handoff-spike-"));
  const fixtureSourcePath = path.join(fixtureRoot, "source");
  await materializeEveFixtureDirectory(FIXTURE_TEMPLATE, fixtureSourcePath);
  const { store, close } = await createPgliteTestStore();
  const workflowRuntime: WorkflowRuntime = await startWorkflowRuntime(store);
  const runtime = createRuntimeAdapterFromEnv();
  const processNames: string[] = [];
  let server: ReturnType<typeof serve> | null = null;
  const world = new pg.Client({
    connectionString: process.env.EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL ?? workflowRuntime.worldUrl,
  });
  try {
    const project = await store.createProject({
      name: `Handoff spike ${Date.now()}`,
      importKind: "zip",
      sourcePath: fixtureSourcePath,
    });
    await store.upsertSecret(
      project.id,
      "EVE_MOCK_AUTHORED_MODELS",
      JSON.stringify(encryptSecretValue("1", APP_SECRET_KEY)),
    );
    const work = () => processNextJob(store, "handoff-spike", { appSecretKey: APP_SECRET_KEY });
    assert.equal(await work(), true);
    await store.enqueueJob(project.id, "build_deploy");
    assert.equal(await work(), true);
    const a = await store.getCurrentDeployment(project.id);
    assert.ok(a);
    processNames.push(a.containerName);
    await store.enqueueJob(project.id, "build_deploy");
    assert.equal(await work(), true);
    const b = (await store.listDeployments(project.id)).find((item) => item.id !== a.id);
    assert.ok(b);
    processNames.push(b.containerName);
    log(`A=${a.id} B=${b.id}`);

    // Keep the stable route on A so the session is created there.
    const stable = await store.findProjectRoute(project.id);
    assert.ok(stable);
    await store.updateRouteTargets(stable.id, [
      { deploymentId: a.id, weight: 10_000, variantName: "control" },
    ]);

    const app = createGatewayApp(store, {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret: "handoff-spike-affinity-secret",
      internalServiceToken: "handoff-spike-secret",
      routeCacheTtlMs: 0,
    });
    server = serve({ fetch: app.fetch, port: 0 });
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("gateway did not bind");
    const port = address.port;
    const host = `${project.slug}.agent.localhost:${GATEWAY_PORT}`;

    await world.connect();
    const runs = async () =>
      (
        await world.query(
          `select id as run_id, deployment_id, name as workflow_name, status, created_at
             from workflow.workflow_runs order by created_at`,
        )
      ).rows as Array<{
        run_id: string;
        deployment_id: string;
        workflow_name: string;
        status: string;
      }>;
    const show = async (label: string) => {
      log(`--- runs ${label}`);
      for (const run of await runs())
        log(
          `  ${run.run_id} ${run.deployment_id === a.id ? "A" : run.deployment_id === b.id ? "B" : run.deployment_id} ${run.status} ${run.workflow_name}`,
        );
    };

    // 1. Session on A, first turn, then idle.
    const created = await request(port, {
      host,
      path: "/eve/v1/session",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Say hello in one short sentence." }),
    });
    assert.equal(created.statusCode, 202, `create failed: ${created.body}`);
    const sessionId =
      created.headers["x-eve-session-id"]?.toString() ??
      (JSON.parse(created.body) as { sessionId?: string }).sessionId;
    assert.ok(sessionId);
    log(`session ${sessionId}`);
    const first = await streamUntil(port, host, sessionId, ["session.waiting"], 120_000);
    log(`first turn events: ${summarize(first)}`);
    const bound = await store.findSessionBinding(project.id, sessionId);
    assert.equal(bound?.deploymentId, a.id, "session should be bound to A");
    await show("after first turn (expect everything on A)");

    // 2. Re-point the binding at B: the gateway change under evaluation.
    const {
      id: _id,
      createdAt: _c,
      updatedAt: _u,
      ...bindingInput
    } = bound as Record<string, unknown>;
    await store.bindSession({ ...bindingInput, deploymentId: b.id } as never);
    assert.equal((await store.findSessionBinding(project.id, sessionId))?.deploymentId, b.id);
    log("binding re-pointed at B");

    // Variant: A's process is gone (scale-to-zero / stopped after promote) but
    // its Release is still activatable, so the dispatcher can wake it.
    if (process.env.HANDOFF_STOP_A === "1") {
      await runtime.stopProcess(a.containerName);
      log("A's process stopped before the follow-up");
    }

    // 3. Follow-up delivery, accepted by B.
    const startedAt = Date.now();
    const followUp = await request(port, {
      host,
      path: `/eve/v1/session/${encodeURIComponent(sessionId)}`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Now say goodbye.", deliveryId: randomUUID() }),
    });
    log(`follow-up -> ${followUp.statusCode} ${followUp.body.slice(0, 300)}`);
    assert.ok(followUp.statusCode < 300, "follow-up was refused");
    const second = await streamUntil(
      port,
      host,
      sessionId,
      ["session.waiting", "session.failed"],
      180_000,
      first.length,
    );
    log(`second turn events (+${Date.now() - startedAt}ms): ${summarize(second)}`);
    await show("after follow-up");

    // 4. A third delivery: the session now lives on B, so nothing should move.
    const thirdAt = Date.now();
    const third = await request(port, {
      host,
      path: `/eve/v1/session/${encodeURIComponent(sessionId)}`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "One more line.", deliveryId: randomUUID() }),
    });
    assert.ok(third.statusCode < 300, `third delivery refused: ${third.body}`);
    const thirdEvents = await streamUntil(
      port,
      host,
      sessionId,
      ["session.waiting", "session.failed"],
      180_000,
      first.length + second.length,
    );
    log(`third turn events (+${Date.now() - thirdAt}ms): ${summarize(thirdEvents)}`);
    await show("after third delivery");

    const entryRuns = (await runs()).filter((run) =>
      /workflowEntry|session/i.test(run.workflow_name),
    );
    const onB = entryRuns.filter((run) => run.deployment_id === b.id);
    log(
      onB.length > 0
        ? `HANDOFF FIRED: ${onB.length} session-owner run(s) on B`
        : "HANDOFF DID NOT FIRE: no session-owner run on B",
    );
    const hooks = await world.query(
      `select token, run_id from workflow.workflow_hooks where token like $1 order by token`,
      [`${sessionId}%`],
    );
    for (const hook of hooks.rows as Array<{ token: string; run_id: string }>)
      log(`  hook ${hook.token} -> ${hook.run_id}`);
  } finally {
    await world.end().catch(() => {});
    server?.close();
    for (const name of processNames) await runtime.stopProcess(name).catch(() => {});
    await workflowRuntime.stop().catch(() => {});
    await close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

function summarize(events: Array<{ type?: string }>): string {
  return events.map((event) => event.type).join(" ");
}

function request(
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
    const req = http.request(
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
    req.once("error", reject);
    req.end(input.body);
  });
}

/** Reads the durable stream from the start and resolves once a stop type shows up after `skip` events. */
function streamUntil(
  port: number,
  host: string,
  sessionId: string,
  stopTypes: string[],
  timeoutMs: number,
  skip = 0,
): Promise<Array<{ type?: string }>> {
  return new Promise((resolve, reject) => {
    const events: Array<{ type?: string }> = [];
    let buffer = "";
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: `/eve/v1/session/${encodeURIComponent(sessionId)}/stream`,
        headers: { host },
      },
      (response) => {
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          buffer += chunk;
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            try {
              events.push(JSON.parse(line) as { type?: string });
            } catch {
              continue;
            }
            const fresh = events.slice(skip);
            if (fresh.some((event) => stopTypes.includes(event.type ?? ""))) {
              response.destroy();
              resolve(fresh);
              return;
            }
          }
        });
        response.on("end", () =>
          reject(new Error(`stream ended early: ${summarize(events.slice(skip))}`)),
        );
      },
    );
    // A wall-clock budget: the stream heartbeats, so an idle timeout never fires.
    const timer = setTimeout(
      () =>
        req.destroy(
          new Error(
            `no ${stopTypes.join("/")} within ${timeoutMs}ms: ${summarize(events.slice(skip))}`,
          ),
        ),
      timeoutMs,
    );
    req.once("close", () => clearTimeout(timer));
    req.once("error", reject);
    req.end();
  });
}

void main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
