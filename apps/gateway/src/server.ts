import { serve } from "@hono/node-server";
import { createStoreFromEnv } from "@eveland/db/factory";
import { createGatewayApp } from "./app.js";

const port = Number(process.env.GATEWAY_PORT ?? 4080);
const allowedBaseDomains = (process.env.EVELAND_AGENT_BASE_DOMAINS ?? "agent.localhost")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const { store, close } = createStoreFromEnv();
await store.reconcileAgentRoutes(allowedBaseDomains[0] ?? "agent.localhost");
const app = createGatewayApp(store, {
  allowedBaseDomains,
  internalServiceToken:
    process.env.EVELAND_GATEWAY_SERVICE_TOKEN ??
    (process.env.NODE_ENV === "production" ? undefined : "eveland-dev-gateway-token"),
});
const server = serve({ fetch: app.fetch, port });

console.log(`Eveland Gateway listening on http://0.0.0.0:${port}`);

async function shutdown() {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await close();
}

process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
