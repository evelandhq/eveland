import { platformObservability } from "./observability.js";
import { serve } from "@hono/node-server";
import { formatBuildInfo } from "@evelandhq/core/build-info";
import { createConfigurationSnapshot } from "@evelandhq/core/config-diagnostics";
import { createBuildInfoFromEnv } from "@evelandhq/core/server/build-info";
import { resolveSecretWithDevFallback } from "@evelandhq/core/server/dev-secrets";
import { createStoreFromEnv } from "@evelandhq/db/factory";
import { createGatewayApp } from "./app.js";
import { withDeploymentEveVersionCache } from "./gateway-eve-version-cache.js";
import { createApiActivationClient } from "./activation-client.js";
import { createApiIdentityClient } from "./identity-client.js";

const port = Number(process.env.GATEWAY_PORT ?? 4080);
const buildInfo = createBuildInfoFromEnv("gateway", process.env);
const allowedBaseDomains = (process.env.EVELAND_AGENT_BASE_DOMAINS ?? "agent.localhost")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
// Fail closed: the publicly known dev secrets apply only under an explicit
// NODE_ENV=development/test. A production host that forgot to set NODE_ENV
// must refuse to start, not serve /internal/* behind a token anyone can read
// in this repository.
const affinitySecret = resolveSecretWithDevFallback(
  process.env,
  process.env.EVELAND_GATEWAY_AFFINITY_SECRET,
  "eveland-dev-affinity-secret",
);
if (!affinitySecret)
  throw new Error(
    "EVELAND_GATEWAY_AFFINITY_SECRET is required unless NODE_ENV is explicitly development.",
  );
const internalServiceToken = resolveSecretWithDevFallback(
  process.env,
  process.env.EVELAND_GATEWAY_SERVICE_TOKEN,
  "eveland-dev-gateway-token",
);
const apiInternalUrl = process.env.EVELAND_API_INTERNAL_URL ?? "http://127.0.0.1:4000";
const { store, close } = createStoreFromEnv();
await store.reconcileAgentRoutes(allowedBaseDomains[0] ?? "agent.localhost");
// The version gate runs on every public request; a Deployment's Eve version
// is immutable, so memoize it instead of paying the join each time.
const app = createGatewayApp(withDeploymentEveVersionCache(store), {
  allowedBaseDomains,
  affinitySecret,
  buildInfo,
  configurationSnapshot: createConfigurationSnapshot("gateway", process.env),
  affinityCookieSecure: (process.env.EVELAND_GATEWAY_PUBLIC_SCHEME ?? "http") === "https",
  maxRequestBodyBytes: Number(process.env.EVELAND_GATEWAY_MAX_REQUEST_BODY_BYTES ?? 10_485_760),
  internalServiceToken,
  activationClient: internalServiceToken
    ? createApiActivationClient({
        apiUrl: apiInternalUrl,
        serviceToken: internalServiceToken,
      })
    : undefined,
  identityClient: internalServiceToken
    ? createApiIdentityClient({
        apiUrl: apiInternalUrl,
        serviceToken: internalServiceToken,
      })
    : undefined,
  activationRenewIntervalMs: Number(process.env.EVELAND_ACTIVATION_RENEW_INTERVAL_MS ?? 60_000),
});
const server = serve({ fetch: app.fetch, port });

console.log(`${formatBuildInfo(buildInfo)} listening on http://0.0.0.0:${port}`);
platformObservability.emitLog({
  severity: "info",
  eventName: "eveland.gateway.ready",
  body: "Eveland Gateway is ready.",
  attributes: { "server.port": port },
});

async function shutdown() {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await Promise.all([close(), platformObservability.shutdown()]);
}

process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
