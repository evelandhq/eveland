import { platformObservability } from "./observability.js";
import { formatBuildInfo } from "@eveland/core/build-info";
import { createBuildInfoFromEnv } from "@eveland/core/server/build-info";
import { resolveSecretWithDevFallback } from "@eveland/core/server/dev-secrets";
import { resolveSchedulerRuntimeSecret } from "@eveland/core/server/scheduler-dispatch";
import { runMigrations } from "@eveland/workflow-world";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createActivationClient } from "./activation-client.js";
import { reenqueueActiveRunsForAllTenants } from "./boot-recovery.js";
import { resolveDispatcherConfig } from "./config.js";
import { startDispatcher } from "./runner.js";

const buildInfo = createBuildInfoFromEnv("workflow-dispatcher", process.env);
const config = resolveDispatcherConfig(process.env);

// Fail closed on secrets, exactly as the gateway does: the published dev
// fallbacks apply only under an explicit NODE_ENV=development/test.
const serviceToken = resolveSecretWithDevFallback(
  process.env,
  process.env.EVELAND_GATEWAY_SERVICE_TOKEN,
  "eveland-dev-gateway-token",
);
if (!serviceToken) {
  throw new Error(
    "EVELAND_GATEWAY_SERVICE_TOKEN is required unless NODE_ENV is explicitly development.",
  );
}
// The same platform→deployment shared secret the scheduler channel uses, and
// already injected into every deployment as EVELAND_SCHEDULER_RUNTIME_SECRET.
// Reusing it means a deployment can authenticate dispatcher traffic without a
// second secret to distribute and rotate.
const runtimeSecret = resolveSchedulerRuntimeSecret(process.env);
if (!runtimeSecret) {
  throw new Error(
    "EVELAND_SCHEDULER_RUNTIME_SECRET is required unless NODE_ENV is explicitly development.",
  );
}

const pool = new Pool({
  connectionString: config.worldUrl,
  max: config.poolSize,
  application_name: `eveland-workflow-dispatcher-${randomUUID().slice(0, 8)}`,
});

await runMigrations(pool, {
  log: (message) => console.log(`[workflow-dispatcher] migrate: ${message}`),
});

const dispatcher = await startDispatcher({
  pool,
  config: {
    concurrency: config.concurrency,
    pollIntervalMs: config.pollIntervalMs,
    maxInFlightPerTenant: config.maxInFlightPerTenant,
  },
  deps: {
    activation: createActivationClient({
      apiUrl: config.apiUrl,
      serviceToken,
    }),
    runtimeSecret,
    dispatchTimeoutMs: config.dispatchTimeoutMs,
    leaseRenewIntervalMs: config.leaseRenewIntervalMs,
    log: (message, meta) =>
      platformObservability.emitLog({
        severity: "info",
        eventName: "eveland.workflow_dispatcher.event",
        body: message,
        attributes: (meta ?? {}) as Record<string, string | number | boolean>,
      }),
  },
});

await reenqueueActiveRunsForAllTenants({
  pool,
  workerUtils: dispatcher.workerUtils,
  log: (message, meta) => console.log(`[workflow-dispatcher] ${message}`, meta ?? ""),
});

console.log(`${formatBuildInfo(buildInfo)} dispatching workflow jobs`);
platformObservability.emitLog({
  severity: "info",
  eventName: "eveland.workflow_dispatcher.ready",
  body: "Eveland workflow dispatcher is ready.",
  attributes: {
    "dispatcher.concurrency": config.concurrency,
    "dispatcher.max_in_flight_per_tenant": config.maxInFlightPerTenant,
  },
});

async function shutdown() {
  await dispatcher.stop();
  await pool.end();
  await platformObservability.shutdown();
}

process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
