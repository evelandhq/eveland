import { serve } from "@hono/node-server";
import { formatBuildInfo } from "@eveland/core/build-info";
import { createConfigurationSnapshot } from "@eveland/core/config-diagnostics";
import { createBuildInfoFromEnv } from "@eveland/core/server/build-info";
import { createStoreFromEnv } from "@eveland/db/factory";
import { createGatewayApp } from "./app.js";
import { createApiActivationClient } from "./activation-client.js";

const port = Number(process.env.GATEWAY_PORT ?? 4080);
const buildInfo = createBuildInfoFromEnv("gateway", process.env);
const allowedBaseDomains = (process.env.EVELAND_AGENT_BASE_DOMAINS ?? "agent.localhost")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const affinitySecret =
  process.env.EVELAND_GATEWAY_AFFINITY_SECRET ??
  (process.env.NODE_ENV === "production" ? null : "eveland-dev-affinity-secret");
if (!affinitySecret) throw new Error("EVELAND_GATEWAY_AFFINITY_SECRET is required in production.");
const internalServiceToken =
  process.env.EVELAND_GATEWAY_SERVICE_TOKEN ??
  (process.env.NODE_ENV === "production" ? undefined : "eveland-dev-gateway-token");
const { store, close } = createStoreFromEnv();
await store.reconcileAgentRoutes(allowedBaseDomains[0] ?? "agent.localhost");
const app = createGatewayApp(store, {
  allowedBaseDomains,
  affinitySecret,
  buildInfo,
  configurationSnapshot: createConfigurationSnapshot("gateway", process.env),
  affinityCookieSecure: (process.env.EVELAND_GATEWAY_PUBLIC_SCHEME ?? "http") === "https",
  maxRequestBodyBytes: Number(process.env.EVELAND_GATEWAY_MAX_REQUEST_BODY_BYTES ?? 10_485_760),
  internalServiceToken,
  activationClient: internalServiceToken
    ? createApiActivationClient({
        apiUrl: process.env.EVELAND_API_INTERNAL_URL ?? "http://127.0.0.1:4000",
        serviceToken: internalServiceToken,
      })
    : undefined,
  activationRenewIntervalMs: Number(process.env.EVELAND_ACTIVATION_RENEW_INTERVAL_MS ?? 60_000),
});
const server = serve({ fetch: app.fetch, port });

console.log(`${formatBuildInfo(buildInfo)} listening on http://0.0.0.0:${port}`);

async function shutdown() {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await close();
}

process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
