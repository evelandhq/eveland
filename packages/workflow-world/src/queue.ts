/**
 * Multi-tenant port of `@workflow/world-postgres`'s queue.
 *
 * The graphile mapping is upstream's — same `jobKey`, same `maxAttempts: 3`,
 * same reschedule semantics. What changes is who claims the work:
 *
 *   * `embedded` keeps the in-process runner, but its graphile job names are
 *     suffixed per tenant. On a shared database an unsuffixed name would let
 *     any agent claim any project's jobs, which is exactly the cross-project
 *     turn stealing that per-project databases were introduced to stop.
 *   * `external` registers no runner at all. Jobs go to a shared, unsuffixed
 *     name that the platform dispatcher claims, tagged with a `project:<id>`
 *     flag so the dispatcher can apply per-tenant fairness caps via
 *     graphile's `forbiddenFlags`.
 *
 * A tenant that switches from embedded to external keeps draining its old
 * suffixed jobs through the old deployment's runner, which is the same run-out
 * shape the world migration itself uses.
 */
import { connect } from "node:net";
import * as Stream from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createWorkflowBaseUrl,
  createWorkflowHealthEndpoint,
  createWorkflowUrl,
} from "@workflow/utils";
import { getWorkflowPort } from "@workflow/utils/get-port";
import {
  getQueuePrefixKind,
  getQueueTopicPrefix,
  MessageId,
  parseQueueName,
  type Queue,
  QueuePayloadSchema,
  type QueuePrefix,
  type ValidQueueName,
  WorkflowInvokePayloadSchema,
} from "@workflow/world";
import { createWorld } from "@workflow/world-local";
import { Logger, makeWorkerUtils, type Runner, run, type WorkerUtils } from "graphile-worker";
import type { Pool } from "pg";
import { monotonicFactory } from "ulid";
import { z } from "zod/v4";
import type { ResolvedWorldConfig } from "./config.js";
import { MessageData } from "./message.js";
import {
  checkDispatchVersion,
  DISPATCH_VERSION_HEADER,
  RUNTIME_SECRET_HEADER,
  secretMatches,
} from "./dispatch-contract.js";
import { MIGRATION_LOCK_KEY } from "./migrate.js";
import { derivePartitionName } from "./tenant.js";

/**
 * Structural stand-in for `@vercel/queue`'s `Transport`. Upstream imports the
 * real type, but it is the only thing that package is used for here and the
 * shape is three members wide, so the dependency is not worth carrying.
 */
type Transport<T> = {
  contentType: string;
  serialize(value: T): Buffer;
  deserialize(stream: ReadableStream<Uint8Array>): Promise<T>;
};

function createGraphileLogger() {
  const isJsonMode = () => process.env.WORKFLOW_JSON_MODE === "1";
  const isVerbose = () => Boolean(process.env.DEBUG);

  return new Logger(() => (level: string, message: string, meta?: unknown) => {
    if (isJsonMode()) return;
    if ((level === "debug" || level === "info") && !isVerbose()) return;
    const pipe = level === "error" ? process.stderr : process.stdout;
    if (meta) {
      pipe.write(`[Graphile Worker] ${message} ${JSON.stringify(meta, null, 2)}\n`);
    } else {
      pipe.write(`[Graphile Worker] ${message}\n`);
    }
  });
}

const graphileLogger = createGraphileLogger();
const COMPLETED_IDEMPOTENCY_CACHE_LIMIT = 10_000;
const GraphileHelpers = z.object({
  job: z.object({
    attempts: z.number().int().positive(),
  }),
});

type HttpExecutionResult =
  | { type: "completed" }
  | { type: "reschedule"; timeoutSeconds: number }
  | {
      type: "error";
      status: number;
      text: string;
      headers: Record<string, string>;
    };

type RunnerStart = { controller: AbortController; promise: Promise<void> };
type LoopbackTarget = { hosts: string[]; port: number };

/**
 * The Postgres queue works by creating two job types in graphile-worker:
 * - `workflow` for workflow jobs
 *   - `step` for step jobs
 *
 * When a message is queued, it is sent to graphile-worker with the appropriate job type.
 * When a job is processed, it is deserialized and then re-queued into the _local world_, showing that
 * we can reuse the local world, mix and match worlds to build
 * hybrid architectures, and even migrate between worlds.
 */
export type PostgresQueue = Queue & {
  start(): Promise<void>;
  close(): Promise<void>;
};

export function createQueue(config: ResolvedWorldConfig, pool: Pool): PostgresQueue {
  const port = config.port ?? (process.env.PORT ? Number(process.env.PORT) : undefined);
  const tenantId = config.tenantId;
  const localWorld = createWorld({ dataDir: undefined, port });

  // JSON transport that preserves Uint8Array values via a tagged
  // envelope ({ __type: 'Uint8Array', data: '<base64>' }).  Required
  // for the resilient start path where runInput.input (a Uint8Array)
  // is sent through the queue.
  const transport: Transport<unknown> = {
    contentType: "application/json",
    serialize(value: unknown): Buffer {
      return Buffer.from(
        JSON.stringify(value, (_key, v) =>
          v instanceof Uint8Array
            ? { __type: "Uint8Array", data: Buffer.from(v).toString("base64") }
            : v,
        ),
      );
    },
    async deserialize(stream: ReadableStream<Uint8Array>): Promise<unknown> {
      const chunks: Uint8Array[] = [];
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString(), (_key, v) =>
        v !== null &&
        typeof v === "object" &&
        v.__type === "Uint8Array" &&
        typeof v.data === "string"
          ? new Uint8Array(Buffer.from(v.data, "base64"))
          : v,
      );
    },
  };
  const generateMessageId = monotonicFactory();

  /**
   * Embedded runners get a per-tenant job name so a shared database cannot let
   * one project's agent claim another's work. External runners share one name,
   * because the dispatcher deliberately claims across all tenants.
   */
  function getJobQueueName(queuePrefix: QueuePrefix): string {
    const kind = getQueuePrefixKind(queuePrefix) === "workflow" ? "flows" : "steps";
    return config.runner === "embedded"
      ? derivePartitionName(`eveland_wf_${kind}`, tenantId)
      : `eveland_wf_${kind}`;
  }

  /**
   * The executor half stays eve's — `@workflow/world-local` owns vqs decoding
   * and hands the message to the runtime. It is wrapped only to enforce the
   * dispatch contract, because this handler is what the platform dispatcher
   * POSTs into and eve's own handler validates nothing beyond header presence.
   */
  const createQueueHandler: Queue["createQueueHandler"] = (prefix, handler) => {
    const inner = localWorld.createQueueHandler(prefix, handler);
    return async (req: Request) => {
      const declaredVersion = req.headers.get(DISPATCH_VERSION_HEADER);
      const rejection = checkDispatchVersion(declaredVersion);
      if (rejection) {
        return Response.json({ error: rejection.error }, { status: rejection.status });
      }
      // A request that claims to be platform dispatch must prove it. Embedded
      // mode POSTs to this same route over loopback without any Eveland
      // headers, so the check keys off the dispatch header rather than being
      // unconditional — it authenticates the platform path without breaking the
      // in-process one.
      //
      // This does NOT make the endpoint safe on its own: the route is reachable
      // from the public internet through the gateway, and eve's own handler
      // authenticates nothing. Closing that is a separate, prerequisite fix.
      if (declaredVersion) {
        const expected = process.env.EVELAND_SCHEDULER_RUNTIME_SECRET;
        if (!expected || !secretMatches(expected, req.headers.get(RUNTIME_SECRET_HEADER))) {
          return Response.json({ error: "Unauthorized workflow dispatch." }, { status: 401 });
        }
      }
      return inner(req);
    };
  };

  /**
   * The real deployment id, not upstream's constant `'postgres'`. Runs record
   * it, and it is what pins an in-flight run to the deployment that can still
   * execute it.
   */
  const getDeploymentId: Queue["getDeploymentId"] = async () => {
    return config.deploymentId;
  };

  const completedMessages = new Set<string>();
  const inflightMessages = new Map<string, Promise<void>>();
  const inflightWorkflowRuns = new Map<string, Promise<"completed" | "rescheduled">>();
  let workerUtils: WorkerUtils | null = null;
  let runner: Runner | null = null;
  let runnerStart: RunnerStart | null = null;
  let closing = false;
  let startPromise: Promise<void> | null = null;

  function markMessageCompleted(idempotencyKey: string) {
    completedMessages.delete(idempotencyKey);
    completedMessages.add(idempotencyKey);
    if (completedMessages.size > COMPLETED_IDEMPOTENCY_CACHE_LIMIT) {
      const oldestKey = completedMessages.values().next().value;
      if (oldestKey) {
        completedMessages.delete(oldestKey);
      }
    }
  }

  async function addGraphileJob({
    queuePrefix,
    queueId,
    body,
    messageId,
    attempt,
    idempotencyKey,
    headers,
    delaySeconds,
    jobKey,
  }: {
    queuePrefix: QueuePrefix;
    queueId: string;
    body: Buffer | Uint8Array;
    messageId: MessageId;
    attempt: number;
    idempotencyKey?: string;
    headers?: Record<string, string>;
    delaySeconds?: number;
    jobKey?: string;
  }) {
    const utils = workerUtils;
    if (!utils) {
      throw new Error("Postgres queue worker utils are not initialized");
    }

    const runAt =
      typeof delaySeconds === "number" && delaySeconds > 0
        ? new Date(Date.now() + delaySeconds * 1000)
        : undefined;

    await utils.addJob(
      getJobQueueName(queuePrefix),
      MessageData.encode({
        id: queueId,
        data: Buffer.from(body),
        attempt,
        messageId,
        idempotencyKey,
        headers,
        tenantId,
        deploymentId: config.deploymentId,
      }),
      {
        ...(jobKey ? { jobKey } : {}),
        ...(runAt ? { runAt } : {}),
        maxAttempts: 3,
        // Read by the dispatcher's `forbiddenFlags` callback to throttle a
        // tenant that is already at its in-flight cap, without starving others.
        flags: [`project:${tenantId}`],
      },
    );
  }

  async function getExecutionBaseUrl(): Promise<string | undefined> {
    if (process.env.WORKFLOW_LOCAL_BASE_URL) {
      return process.env.WORKFLOW_LOCAL_BASE_URL;
    }

    if (typeof port === "number") {
      return createWorkflowBaseUrl(`http://localhost:${port}`);
    }

    if (process.env.PORT) {
      return createWorkflowBaseUrl(`http://localhost:${process.env.PORT}`);
    }

    const detectedPort = await getWorkflowPort({
      endpoint: createWorkflowHealthEndpoint(),
    });
    if (typeof detectedPort === "number") {
      return createWorkflowBaseUrl(`http://localhost:${detectedPort}`);
    }

    return undefined;
  }

  function getLoopbackHosts(hostname: string): string[] {
    if (hostname === "localhost") {
      return ["127.0.0.1", "::1"];
    }
    if (hostname === "[::1]") {
      return ["::1"];
    }
    return hostname === "127.0.0.1" || hostname === "::1" ? [hostname] : [];
  }

  function getLoopbackTarget(baseUrl: string | undefined) {
    if (!baseUrl) {
      return undefined;
    }

    const url = new URL(baseUrl);
    const hosts = getLoopbackHosts(url.hostname);
    if (hosts.length === 0) {
      return undefined;
    }

    return {
      hosts,
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    };
  }

  async function canConnectToLoopbackTarget(target: LoopbackTarget): Promise<boolean> {
    for (const host of target.hosts) {
      const reachable = await new Promise<boolean>((resolve) => {
        const socket = connect({ host, port: target.port });
        socket.unref();
        const finish = (isReachable: boolean) => {
          socket.destroy();
          resolve(isReachable);
        };

        socket.setTimeout(200, () => finish(false));
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
      });

      if (reachable) {
        return true;
      }
    }

    return false;
  }

  async function startRunnerUnlessAborted(controller: AbortController) {
    if (controller.signal.aborted) {
      return;
    }

    await setupListeners();
  }

  async function waitForLoopbackAndStartRunner(
    controller: AbortController,
    target: LoopbackTarget,
  ) {
    while (!controller.signal.aborted && !(await canConnectToLoopbackTarget(target))) {
      await sleep(50, undefined, {
        ref: false,
      });
    }

    await startRunnerUnlessAborted(controller);
  }

  function deferRunnerStart(controller: AbortController, target: LoopbackTarget) {
    const promise = waitForLoopbackAndStartRunner(controller, target)
      .catch((err) => {
        if (!controller.signal.aborted) {
          console.warn(
            "[eveland workflow world] Failed to start Graphile Worker after local workflow executor became reachable:",
            err,
          );
        }
      })
      .finally(() => {
        if (runnerStart?.promise === promise) {
          runnerStart = null;
        }
      });
    runnerStart = { controller, promise };
  }

  function getQueueRoute(queueName: ValidQueueName): "flow" | "step" {
    return parseQueueName(queueName).kind === "workflow" ? "flow" : "step";
  }

  async function executeMessageOverHttp({
    queueName,
    messageId,
    attempt,
    body,
    headers: extraHeaders,
  }: {
    queueName: ValidQueueName;
    messageId: MessageId;
    attempt: number;
    body: Uint8Array;
    headers?: Record<string, string>;
  }): Promise<HttpExecutionResult> {
    const headers: Record<string, string> = {
      ...extraHeaders,
      "content-type": "application/json",
      "x-vqs-queue-name": queueName,
      "x-vqs-message-id": messageId,
      "x-vqs-message-attempt": String(attempt),
    };
    const baseUrl = await getExecutionBaseUrl();
    if (!baseUrl) {
      throw new Error("Unable to resolve base URL for workflow queue.");
    }
    const pathname = getQueueRoute(queueName);

    const response = await fetch(createWorkflowUrl(baseUrl, { type: pathname }), {
      method: "POST",
      duplex: "half",
      headers,
      body,
    } as any);
    const text = await response.text();

    if (!response.ok) {
      return {
        type: "error",
        status: response.status,
        text,
        headers: Object.fromEntries(response.headers.entries()),
      };
    }

    try {
      const timeoutSeconds = Number(JSON.parse(text).timeoutSeconds);
      if (Number.isFinite(timeoutSeconds) && timeoutSeconds >= 0) {
        return { type: "reschedule", timeoutSeconds };
      }
    } catch {}

    return { type: "completed" };
  }

  async function startRunnerWhenExecutorIsReady(): Promise<void> {
    // External mode has no in-process runner: the platform dispatcher claims
    // this tenant's jobs and POSTs them back. This is the whole point of the
    // split — a durable timer must still fire once this process is idle-reaped.
    if (config.runner === "external") {
      return;
    }
    if (closing || runner || runnerStart) {
      return;
    }

    const controller = new AbortController();
    const promise = (async () => {
      const target = getLoopbackTarget(await getExecutionBaseUrl());
      if (!target) {
        await startRunnerUnlessAborted(controller);
        return;
      }

      if (await canConnectToLoopbackTarget(target)) {
        await startRunnerUnlessAborted(controller);
        return;
      }

      if (controller.signal.aborted) {
        return;
      }

      deferRunnerStart(controller, target);
    })().finally(() => {
      if (runnerStart?.promise === promise) {
        runnerStart = null;
      }
    });
    runnerStart = { controller, promise };
    await promise;
  }

  async function start(): Promise<void> {
    if (closing) {
      return;
    }

    if (!startPromise) {
      startPromise = (async () => {
        try {
          workerUtils = await makeWorkerUtils({
            pgPool: pool,
            logger: graphileLogger,
          });
          // graphile's installSchema is not race-safe, and on a shared database
          // every agent boot would race every other. `bin/setup` normally has
          // run already, which makes this a no-op; the advisory lock covers the
          // case where it has not.
          const migrationClient = await pool.connect();
          try {
            await migrationClient.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
            await workerUtils.migrate();
          } finally {
            await migrationClient
              .query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY])
              .catch(() => {});
            migrationClient.release();
          }
          await startRunnerWhenExecutorIsReady();
        } catch (err) {
          startPromise = null;
          throw err;
        }
      })();
    }
    await startPromise;
    if (!closing && !runner && !runnerStart) {
      await startRunnerWhenExecutorIsReady();
    }
  }

  const queue: Queue["queue"] = async (queue, message, opts) => {
    await start();
    const { prefix: queuePrefix, id: queueId } = parseQueueName(queue);
    const body = transport.serialize(message) as Buffer;
    const messageId = MessageId.parse(`msg_${generateMessageId()}`);
    await addGraphileJob({
      queuePrefix,
      queueId,
      body,
      messageId,
      attempt: 1,
      idempotencyKey: opts?.idempotencyKey,
      headers: opts?.headers,
      delaySeconds: opts?.delaySeconds,
      jobKey: opts?.idempotencyKey ?? messageId,
    });
    return { messageId };
  };

  function createTaskHandler(queue: QueuePrefix) {
    const queueKind = getQueuePrefixKind(queue);

    return async (payload: unknown, helpers: unknown) => {
      const messageData = MessageData.parse(payload);
      const graphileAttempt = GraphileHelpers.safeParse(helpers);
      const attempt = graphileAttempt.success
        ? graphileAttempt.data.job.attempts
        : messageData.attempt;
      const queueName = `${queue}${messageData.id}` as ValidQueueName;
      const bodyStream = Stream.Readable.toWeb(Stream.Readable.from([messageData.data]));
      const body = await transport.deserialize(bodyStream as ReadableStream<Uint8Array>);
      QueuePayloadSchema.parse(body);
      const workflowRunSerializationKey =
        queueKind === "workflow"
          ? (() => {
              const workflowInvoke = WorkflowInvokePayloadSchema.safeParse(body);
              if (!workflowInvoke.success) {
                return undefined;
              }
              return `workflow:${workflowInvoke.data.runId}`;
            })()
          : undefined;
      const executeTask = async (): Promise<"completed" | "rescheduled"> => {
        const result = await executeMessageOverHttp({
          queueName,
          messageId: messageData.messageId,
          attempt,
          body: messageData.data,
          headers: messageData.headers,
        });

        if (result.type === "completed") {
          return "completed";
        }

        if (result.type === "reschedule") {
          // Schedule the follow-up job before we return so a crash cannot
          // lose the wake-up request.
          await addGraphileJob({
            queuePrefix: queue,
            queueId: messageData.id,
            body: messageData.data,
            messageId: messageData.messageId,
            attempt: attempt + 1,
            idempotencyKey: messageData.idempotencyKey,
            headers: messageData.headers,
            delaySeconds: result.timeoutSeconds,
            jobKey: messageData.idempotencyKey ?? messageData.messageId,
          });
          return "rescheduled";
        }

        throw new Error(
          `[eveland workflow world] Queue execution failed (${result.status}): ${result.text}`,
        );
      };

      const idempotencyKey = messageData.idempotencyKey;
      if (!idempotencyKey) {
        if (workflowRunSerializationKey) {
          // Preserve step fan-out while preventing two workflow replays from
          // mutating the same run's event log at the same time.
          const previous = inflightWorkflowRuns.get(workflowRunSerializationKey);
          const execution = (previous ?? Promise.resolve())
            .catch(() => {})
            .then(() => executeTask())
            .finally(() => {
              if (inflightWorkflowRuns.get(workflowRunSerializationKey) === execution) {
                inflightWorkflowRuns.delete(workflowRunSerializationKey);
              }
            });
          inflightWorkflowRuns.set(workflowRunSerializationKey, execution);
          await execution;
          return;
        }

        await executeTask();
        return;
      }

      if (completedMessages.has(idempotencyKey)) {
        return;
      }

      const existing = inflightMessages.get(idempotencyKey);
      if (existing) {
        await existing;
        return;
      }

      const execution = executeTask()
        .then((result) => {
          if (result === "completed") {
            markMessageCompleted(idempotencyKey);
          }
        })
        .finally(() => {
          inflightMessages.delete(idempotencyKey);
        });
      inflightMessages.set(idempotencyKey, execution);
      await execution;
    };
  }

  async function setupListeners() {
    const taskList: Record<string, (payload: unknown, helpers: unknown) => Promise<void>> = {};
    const workflowPrefix = getQueueTopicPrefix("workflow");
    const stepPrefix = getQueueTopicPrefix("step");
    taskList[getJobQueueName(workflowPrefix)] = createTaskHandler(workflowPrefix);
    taskList[getJobQueueName(stepPrefix)] = createTaskHandler(stepPrefix);

    runner = await run({
      pgPool: pool,
      // Default of 50 is high enough to avoid worker-pool exhaustion in
      // workflows that use parent→child polling patterns (e.g. awaiting a
      // child workflow via `childRun.returnValue` inside the parent).
      // Every such poll holds a worker slot for the duration of the child
      // run. Recursive workflows like `fibonacciWorkflow` fan out quickly
      // — fib(6) produces ~24 concurrent polling steps at peak, and at
      // concurrency=10 (the previous default) it would deadlock on the
      // default Postgres setup. See packages/core/src/runtime/run.ts and
      // docs/content/docs/changelog/eager-processing.mdx for context.
      concurrency: config.queueConcurrency,
      logger: graphileLogger,
      pollInterval: 500, // 500ms = 0.5s (graphile-worker uses LISTEN/NOTIFY when available)
      taskList,
    });
  }

  return {
    createQueueHandler,
    getDeploymentId,
    queue,
    start,
    async close() {
      closing = true;
      if (runnerStart) {
        runnerStart.controller.abort();
        await runnerStart.promise;
        runnerStart = null;
      }
      await startPromise?.catch(() => {});
      if (runner) {
        await runner.stop();
        runner = null;
      }
      if (workerUtils) {
        await workerUtils.release();
        workerUtils = null;
      }
      startPromise = null;
      await localWorld.close?.();
    },
  };
}
