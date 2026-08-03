import type { MessageData } from "@eveland/workflow-world";
import { DISPATCH_VERSION_HEADER, RUNTIME_SECRET_HEADER } from "@eveland/workflow-world";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ActivationClient, ActivationOutcome } from "./activation-client.js";
import {
  createFairness,
  dispatchMessage,
  readRunId,
  resolveAffinity,
  type DispatcherDeps,
  type RunLookup,
} from "./dispatcher.js";

/**
 * One test per row of the design's delivery-and-failure table. The point is
 * that each failure maps onto the *right* outcome: a retry that should not be a
 * dead-letter silently strands a run, and a dead-letter that should have been a
 * retry loses work that would have succeeded.
 */

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function startFakeAgent(
  handler: (request: { headers: Record<string, string | string[] | undefined>; body: Buffer }) => {
    status: number;
    body: string;
  },
): Promise<number> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const result = handler({ headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(result.status, { "content-type": "application/json" });
      res.end(result.body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  return address.port;
}

function message(overrides: Partial<MessageData> = {}): MessageData {
  return {
    id: "__wkf_workflow_greet",
    data: Buffer.from(JSON.stringify({ runId: "wrun_1" })),
    attempt: 1,
    messageId: "msg_1" as MessageData["messageId"],
    tenantId: "p_alpha",
    deploymentId: "dep_1",
    ...overrides,
  } as MessageData;
}

function activationClient(outcome: ActivationOutcome, endpointPort = 1): ActivationClient {
  return {
    activate: vi.fn(
      async (): Promise<ActivationOutcome> =>
        outcome.type === "activated"
          ? { type: "activated", activation: { leaseId: "lease_1", endpointPort } }
          : outcome,
    ),
    renew: vi.fn(async () => true),
    release: vi.fn(async () => {}),
  };
}

function deps(overrides: Partial<DispatcherDeps> = {}): DispatcherDeps {
  return {
    activation: activationClient({
      type: "activated",
      activation: { leaseId: "l", endpointPort: 1 },
    }),
    runLookup: async () => null,
    runtimeSecret: "s3cret",
    credential: "token",
    dispatchTimeoutMs: 5_000,
    leaseRenewIntervalMs: 60_000,
    reenqueue: vi.fn(async () => {}),
    onDeadLetter: vi.fn(async () => {}),
    ...overrides,
  };
}

const dispatch = (d: DispatcherDeps, msg = message(), attempt = 1) =>
  dispatchMessage(
    { message: msg, jobName: "eveland_wf_flows", queueName: msg.id, route: "flow", attempt },
    d,
  );

describe("affinity", () => {
  test("reads the run id out of a workflow payload", () => {
    expect(readRunId(message())).toBe("wrun_1");
  });

  test("reads the run id out of a step payload", () => {
    expect(
      readRunId(message({ data: Buffer.from(JSON.stringify({ workflowRunId: "wrun_9" })) })),
    ).toBe("wrun_9");
  });

  test("pins an in-flight run to the deployment that created it, not the enqueuer", async () => {
    // This is the whole point of affinity: only the build that created the run
    // has a bundle able to replay its event log.
    const lookup: RunLookup = async () => ({ deploymentId: "dep_old", status: "running" });
    const affinity = await resolveAffinity(message({ deploymentId: "dep_new" }), lookup);
    expect(affinity).toEqual({ type: "deployment", deploymentId: "dep_old", runId: "wrun_1" });
  });

  test("falls back to the enqueuing deployment when the run row does not exist yet", async () => {
    // First delivery: the executor creates the run while handling this message.
    const affinity = await resolveAffinity(message({ deploymentId: "dep_new" }), async () => null);
    expect(affinity).toMatchObject({ type: "deployment", deploymentId: "dep_new" });
  });

  test("treats a terminal run as unroutable", async () => {
    const affinity = await resolveAffinity(message(), async () => ({
      deploymentId: "dep_1",
      status: "completed",
    }));
    expect(affinity.type).toBe("unroutable");
  });
});

describe("dispatch outcomes", () => {
  test("a 200 {ok:true} completes the job", async () => {
    const port = await startFakeAgent(() => ({ status: 200, body: JSON.stringify({ ok: true }) }));
    const d = deps({
      activation: activationClient(
        { type: "activated", activation: { leaseId: "l", endpointPort: port } },
        port,
      ),
    });
    await expect(dispatch(d)).resolves.toEqual({ type: "completed" });
  });

  test("sends the vqs and Eveland headers the contract specifies", async () => {
    let seen: Record<string, unknown> = {};
    const port = await startFakeAgent(({ headers }) => {
      seen = headers;
      return { status: 200, body: JSON.stringify({ ok: true }) };
    });
    const d = deps({
      activation: activationClient(
        { type: "activated", activation: { leaseId: "l", endpointPort: port } },
        port,
      ),
    });
    await dispatch(d);

    expect(seen["x-vqs-queue-name"]).toBe("__wkf_workflow_greet");
    expect(seen["x-vqs-message-id"]).toBe("msg_1");
    expect(seen["x-vqs-message-attempt"]).toBe("1");
    expect(seen[DISPATCH_VERSION_HEADER]).toBe("1");
    expect(seen[RUNTIME_SECRET_HEADER]).toBe("s3cret");
    expect(seen.authorization).toBe("Bearer token");
  });

  test("a {timeoutSeconds} response re-enqueues the SAME message id", async () => {
    // The runtime uses the message id as its step-ownership lease; minting a new
    // one here would silently degrade crash recovery to the delayed backstop.
    const port = await startFakeAgent(() => ({
      status: 200,
      body: JSON.stringify({ timeoutSeconds: 30 }),
    }));
    const reenqueue = vi.fn(async () => {});
    const d = deps({
      activation: activationClient(
        { type: "activated", activation: { leaseId: "l", endpointPort: port } },
        port,
      ),
      reenqueue,
    });

    await expect(dispatch(d)).resolves.toEqual({ type: "rescheduled", timeoutSeconds: 30 });
    expect(reenqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        delaySeconds: 30,
        message: expect.objectContaining({ messageId: "msg_1", attempt: 2 }),
      }),
    );
  });

  test("a 5xx is retryable", async () => {
    const port = await startFakeAgent(() => ({ status: 503, body: "unavailable" }));
    const d = deps({
      activation: activationClient(
        { type: "activated", activation: { leaseId: "l", endpointPort: port } },
        port,
      ),
    });
    await expect(dispatch(d)).resolves.toMatchObject({ type: "retry" });
  });

  test("a 4xx dead-letters instead of burning retries", async () => {
    // The deployment will never accept this message — a malformed dispatch or a
    // dispatch version it refuses. Retrying just spends the budget.
    const port = await startFakeAgent(() => ({ status: 400, body: "bad dispatch version" }));
    const d = deps({
      activation: activationClient(
        { type: "activated", activation: { leaseId: "l", endpointPort: port } },
        port,
      ),
    });
    await expect(dispatch(d)).resolves.toMatchObject({ type: "dead-letter" });
  });

  test("an archived deployment dead-letters rather than retrying forever", async () => {
    const d = deps({
      activation: activationClient({
        type: "not-activatable",
        status: 409,
        message: "Deployment is not activatable",
      }),
    });
    const outcome = await dispatch(d);
    expect(outcome).toMatchObject({ type: "dead-letter" });
    expect((outcome as { reason: string }).reason).toContain("not activatable");
  });

  test("an unavailable control API is retryable", async () => {
    const d = deps({
      activation: activationClient({ type: "unavailable", status: 503, message: "down" }),
    });
    await expect(dispatch(d)).resolves.toMatchObject({ type: "retry" });
  });

  test("a straggler for a terminal run is dropped, not retried", async () => {
    const d = deps({
      runLookup: async () => ({ deploymentId: "dep_1", status: "completed" }),
    });
    await expect(dispatch(d)).resolves.toEqual({ type: "completed" });
  });

  test("the activation lease is released even when dispatch fails", async () => {
    const port = await startFakeAgent(() => ({ status: 500, body: "boom" }));
    const activation = activationClient(
      { type: "activated", activation: { leaseId: "l", endpointPort: port } },
      port,
    );
    await dispatch(deps({ activation }));
    expect(activation.release).toHaveBeenCalledWith("lease_1");
  });
});

describe("fairness", () => {
  test("forbids a tenant only once it is at its cap", () => {
    const fairness = createFairness({ maxInFlightPerTenant: 2 });
    expect(fairness.forbiddenFlags()).toEqual([]);

    fairness.acquire("p_alpha");
    expect(fairness.forbiddenFlags()).toEqual([]);

    fairness.acquire("p_alpha");
    expect(fairness.forbiddenFlags()).toEqual(["project:p_alpha"]);
  });

  test("one busy tenant does not block another", () => {
    const fairness = createFairness({ maxInFlightPerTenant: 1 });
    fairness.acquire("p_alpha");
    expect(fairness.forbiddenFlags()).toEqual(["project:p_alpha"]);
    expect(fairness.forbiddenFlags()).not.toContain("project:p_beta");
  });

  test("releasing frees the slot and forgets the tenant", () => {
    const fairness = createFairness({ maxInFlightPerTenant: 1 });
    fairness.acquire("p_alpha");
    fairness.release("p_alpha");
    expect(fairness.forbiddenFlags()).toEqual([]);
    expect(fairness.snapshot()).toEqual({});
  });
});
