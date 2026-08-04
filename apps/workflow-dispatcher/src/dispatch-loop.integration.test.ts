import { createWorld, ensureTenantPartitions, runMigrations } from "@eveland/workflow-world";
import { getQueueTopicPrefix, type ValidQueueName } from "@workflow/world";
import { createServer, type Server } from "node:http";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { ActivationClient } from "./activation-client.js";
import { startDispatcher, type DispatcherRuntime } from "./runner.js";

/**
 * The real dispatch loop, end to end: a message enqueued by the actual world,
 * claimed by the actual dispatcher, and delivered into eve's actual queue
 * handler.
 *
 * The unit tests around this file all talk to a fake agent that accepts
 * anything. That is what let two blockers ship green — the dispatcher sent a
 * queue name eve rejects with a 400, and requested an activation kind the
 * control plane refuses. Both are invisible to a fake written from the same
 * misunderstanding, and both are caught here, because the thing on the
 * receiving end is the real handler rather than a stand-in.
 *
 * Only the control API is faked, and only because it is a separate process; the
 * shape it returns is asserted against the real schema in the architecture
 * tests instead.
 *
 * Set `EVELAND_WORKFLOW_WORLD_TEST_URL` to a scratch database to run it.
 */
const testUrl = process.env.EVELAND_WORKFLOW_WORLD_TEST_URL;
const suffix = `${String(process.pid)}${Date.now().toString(36)}`;
const TENANT = `p_loop_${suffix}`;
const DEPLOYMENT = `dep_loop_${suffix}`;
const RUNTIME_SECRET = "loop-test-runtime-secret-000000000";

describe.skipIf(!testUrl)("dispatch loop", () => {
  let admin: Pool;
  let dispatcherPool: Pool;
  let world: ReturnType<typeof createWorld>;
  let dispatcher: DispatcherRuntime;
  let agent: Server;
  let agentPort: number;
  /** Messages eve's handler actually accepted and passed to the runtime. */
  const delivered: Array<{ queueName: string; messageId: string; attempt: number }> = [];
  /** Responses eve's handler produced, including the ones it refused. */
  const responses: number[] = [];
  let released = 0;

  beforeAll(async () => {
    process.env.EVELAND_SCHEDULER_RUNTIME_SECRET = RUNTIME_SECRET;
    process.env.EVELAND_DEPLOYMENT_ID = DEPLOYMENT;

    admin = new Pool({ connectionString: testUrl, max: 2 });
    await runMigrations(admin);
    await ensureTenantPartitions(admin, TENANT);

    world = createWorld({
      connectionString: testUrl!,
      tenantId: TENANT,
      deploymentId: DEPLOYMENT,
      runner: "external",
    });

    // eve's real queue handler, wrapped by ours. This is what validates the
    // queue-name prefix, the dispatch version and the runtime secret.
    const handler = world.createQueueHandler(getQueueTopicPrefix("workflow"), async (_m, meta) => {
      delivered.push({
        queueName: meta.queueName,
        messageId: meta.messageId,
        attempt: meta.attempt,
      });
    });

    agent = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        void (async () => {
          const response = await handler(
            new Request(`http://127.0.0.1${req.url ?? "/"}`, {
              method: req.method ?? "POST",
              headers: req.headers as Record<string, string>,
              body: Buffer.concat(chunks),
            }),
          );
          responses.push(response.status);
          res.writeHead(response.status, { "content-type": "application/json" });
          res.end(await response.text());
        })();
      });
    });
    await new Promise<void>((resolve) => agent.listen(0, "127.0.0.1", resolve));
    const address = agent.address();
    if (typeof address === "string" || !address) throw new Error("no port");
    agentPort = address.port;

    const activation: ActivationClient = {
      async activate() {
        return {
          type: "activated",
          activation: { leaseId: `lease_${suffix}`, endpointPort: agentPort },
        };
      },
      async renew() {
        return true;
      },
      async release() {
        released += 1;
      },
    };

    dispatcherPool = new Pool({ connectionString: testUrl, max: 4 });
    dispatcher = await startDispatcher({
      pool: dispatcherPool,
      config: { concurrency: 4, pollIntervalMs: 100, maxInFlightPerTenant: 4 },
      deps: {
        activation,
        runtimeSecret: RUNTIME_SECRET,
        dispatchTimeoutMs: 10_000,
        leaseRenewIntervalMs: 60_000,
      },
    });
  }, 120_000);

  afterAll(async () => {
    await dispatcher?.stop().catch(() => {});
    await world?.close?.().catch(() => {});
    await new Promise<void>((resolve) => agent?.close(() => resolve()));
    await dispatcherPool?.end().catch(() => {});
    await admin?.end().catch(() => {});
  });

  test("a message enqueued by the world is delivered into eve's real handler", async () => {
    const run = await world.events.create(null, {
      eventType: "run_created",
      eventData: { deploymentId: DEPLOYMENT, workflowName: "greet", input: [] },
      specVersion: 5,
    });
    const runId = run.run!.runId;

    await world.queue(`${getQueueTopicPrefix("workflow")}greet` as ValidQueueName, { runId });

    await waitFor(() => delivered.length > 0, 30_000);

    const message = delivered[0]!;
    // The full prefixed name. Sending the bare sub-queue id — which is what
    // `MessageData.id` holds — makes eve answer 400 "Unhandled queue", and a
    // 400 is non-retryable, so every message would dead-letter.
    expect(message.queueName).toBe("__wkf_workflow_greet");
    expect(message.messageId).toMatch(/^msg_/);
    expect(message.attempt).toBeGreaterThanOrEqual(1);

    // Nothing was refused along the way: no 400 from the queue-name check, no
    // 401 from the secret or deployment binding.
    expect(responses.every((status) => status === 200)).toBe(true);
    expect(released).toBeGreaterThan(0);
  }, 60_000);

  test("a dispatch addressed to another deployment is refused", async () => {
    // The runtime secret is shared platform-wide, so the deployment id is what
    // stops a captured dispatch being replayed at a different agent on the host.
    const response = await fetch(
      `http://127.0.0.1:${String(agentPort)}/.well-known/workflow/v1/flow`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-vqs-queue-name": "__wkf_workflow_greet",
          "x-vqs-message-id": "msg_replayed",
          "x-vqs-message-attempt": "1",
          "x-eveland-dispatch-version": "1",
          "x-eveland-runtime-secret": RUNTIME_SECRET,
          "x-eveland-deployment-id": "dep_somebody_else",
        },
        body: JSON.stringify({ runId: "wrun_replayed" }),
      },
    );
    expect(response.status).toBe(401);
  });

  test("a dispatch without the runtime secret is refused", async () => {
    const response = await fetch(
      `http://127.0.0.1:${String(agentPort)}/.well-known/workflow/v1/flow`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-vqs-queue-name": "__wkf_workflow_greet",
          "x-vqs-message-id": "msg_forged",
          "x-vqs-message-attempt": "1",
          "x-eveland-dispatch-version": "1",
        },
        body: JSON.stringify({ runId: "wrun_forged" }),
      },
    );
    expect(response.status).toBe(401);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the dispatch loop");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
