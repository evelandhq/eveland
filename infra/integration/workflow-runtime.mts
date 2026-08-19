import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createApp } from "../../apps/api/src/app.js";
import { processNextJob } from "../../apps/worker/src/jobs/process.js";
import {
  spawnDispatcherApp,
  waitForDispatcherRegistration,
} from "../../apps/worker/src/integration/dispatcher-process.js";
// Resolved through the worker's own dependency tree: infra scripts are not a
// package and have no bare-specifier resolution of their own.
import { serve } from "../../apps/api/node_modules/@hono/node-server/dist/index.mjs";
import pg from "../../apps/worker/node_modules/pg/lib/index.js";

/**
 * The post-cutover execution topology for the live smokes: every new Release
 * is a shared-World build and its turns execute only through the external
 * dispatcher. A smoke that drives a real turn therefore needs three things
 * this helper provides around its in-process store:
 *
 *   1. a FRESH scratch World database (so one smoke's runs never feed the
 *      next dispatcher's boot recovery),
 *   2. the internal Control API served over the SAME store (activation is
 *      registration- and instance-bound),
 *   3. the real dispatcher app, registered and ready.
 *
 * Call it BEFORE the first build/deploy: it exports the scratch World URL
 * into process.env so the worker paths inject it into the Release.
 */
export type WorkflowRuntime = {
  apiPort: number;
  worldUrl: string;
  stop: () => Promise<void>;
};

export async function startWorkflowRuntime(
  store: Parameters<typeof createApp>[0],
  log: (line: string) => void = (line) => console.log(`[workflow-runtime] ${line}`),
): Promise<WorkflowRuntime> {
  const baseUrl = process.env.EVELAND_WORKFLOW_WORLD_URL;
  if (!baseUrl) {
    throw new Error(
      "EVELAND_WORKFLOW_WORLD_URL is required: post-cutover turns execute only through the external dispatcher.",
    );
  }
  // Deployment-facing vs host-facing views of the same server (Docker's
  // host.docker.internal split); on the Lima guest both are 127.0.0.1.
  const hostBaseUrl = process.env.EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL ?? baseUrl;

  // A scratch database per smoke: boot recovery re-enqueues every active run
  // it can see, so a shared database would make each dispatcher chew through
  // the previous smokes' leftovers (and their deployments no longer exist in
  // this smoke's store).
  const adminUrl = new URL(hostBaseUrl);
  adminUrl.pathname = "/postgres";
  const worldDbName = `eveland_wfw_smoke_${Date.now().toString(36)}`;
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`create database "${worldDbName}"`);
  } finally {
    await admin.end().catch(() => {});
  }
  const worldUrl = new URL(baseUrl);
  worldUrl.pathname = `/${worldDbName}`;
  const hostWorldUrl = new URL(hostBaseUrl);
  hostWorldUrl.pathname = `/${worldDbName}`;
  // The worker's build/deploy paths read these at call time; the dispatcher
  // (which migrates the fresh database at boot) gets them via its spawn env.
  process.env.EVELAND_WORKFLOW_WORLD_URL = worldUrl.toString();
  process.env.EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL = hostWorldUrl.toString();

  const token =
    process.env.WORKFLOW_DISPATCHER_ACTIVATION_TOKEN ??
    process.env.EVELAND_GATEWAY_SERVICE_TOKEN ??
    "eveland-dev-gateway-token";
  // The dispatch runtime secret must agree on both ends: exported here so the
  // worker injects it into every deployment it builds, and passed to the
  // dispatcher explicitly. An unset NODE_ENV counts as production upstream,
  // so there is no silent dev fallback to lean on.
  process.env.EVELAND_SCHEDULER_RUNTIME_SECRET ??= "eveland-smoke-runtime-secret";
  const runtimeSecret = process.env.EVELAND_SCHEDULER_RUNTIME_SECRET;
  // createApp requires an auth service outside NODE_ENV=test; these smokes
  // exercise the internal service surface only, exactly like the API tests.
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  let app: ReturnType<typeof createApp>;
  try {
    app = createApp(store, { gatewayServiceToken: token });
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
  const server = serve({ fetch: app.fetch, port: 0 });
  await once(server, "listening");
  const apiPort = (server.address() as AddressInfo).port;

  const dispatcher = spawnDispatcherApp(
    {
      EVELAND_WORKFLOW_WORLD_URL: hostWorldUrl.toString(),
      EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL: hostWorldUrl.toString(),
      WORKFLOW_DISPATCHER_ACTIVATION_API_URL: `http://127.0.0.1:${String(apiPort)}`,
      WORKFLOW_DISPATCHER_ACTIVATION_TOKEN: token,
      EVELAND_SCHEDULER_RUNTIME_SECRET: runtimeSecret,
      EVELAND_WORKFLOW_DISPATCHER_HEARTBEAT_INTERVAL_MS: "2000",
    },
    log,
  );
  await waitForDispatcherRegistration(store);

  // The smokes drive their own import/build jobs by hand, but a dispatcher
  // activation of a cold deployment parks an ensure_deployment_running job
  // and waits. Pump exactly the activation job family — never the smoke's
  // own import/build assertions.
  let pumping = false;
  let stopped = false;
  const pump = setInterval(() => {
    if (pumping || stopped) return;
    pumping = true;
    void (async () => {
      try {
        for (;;) {
          const processed = await processNextJob(store, "workflow-runtime-pump", {
            appSecretKey: process.env.APP_SECRET_KEY ?? "eveland-dev-secret-key-000000000",
            allowedJobTypes: ["ensure_deployment_running", "restart_deployment"],
          });
          if (!processed) break;
        }
      } catch (error) {
        log(`activation pump error: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        pumping = false;
      }
    })();
  }, 500);
  log(`workflow runtime ready: api :${String(apiPort)}, world ${worldDbName}`);

  return {
    apiPort,
    worldUrl: hostWorldUrl.toString(),
    stop: async () => {
      stopped = true;
      clearInterval(pump);
      await dispatcher.stop().catch(() => {});
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
