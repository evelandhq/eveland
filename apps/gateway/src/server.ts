import { platformObservability } from "./observability.js";
import { serve } from "@hono/node-server";
import { formatBuildInfo } from "@evelandhq/core/build-info";
import {
  API_INTERNAL_URL_FALLBACK,
  GATEWAY_PORT as DEFAULT_GATEWAY_PORT,
  WEB_INTERNAL_URL_FALLBACK,
} from "@evelandhq/core/ports";
import { request as httpRequest } from "node:http";
import { createConfigurationSnapshot } from "@evelandhq/core/config-diagnostics";
import { createBuildInfoFromEnv } from "@evelandhq/core/server/build-info";
import { resolveSecretWithDevFallback } from "@evelandhq/core/server/dev-secrets";
import { createStoreFromEnv } from "@evelandhq/db/factory";
import { createGatewayApp } from "./app.js";
import { withDeploymentEveVersionCache } from "./gateway-eve-version-cache.js";
import { createApiActivationClient } from "./activation-client.js";
import { createApiIdentityClient } from "./identity-client.js";

const port = Number(process.env.GATEWAY_PORT ?? DEFAULT_GATEWAY_PORT);
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
const apiInternalUrl = process.env.EVELAND_API_INTERNAL_URL ?? API_INTERNAL_URL_FALLBACK;
const webInternalUrl = process.env.EVELAND_WEB_INTERNAL_URL ?? WEB_INTERNAL_URL_FALLBACK;
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
  telemetry: {
    emit(event) {
      platformObservability.emitLog(event);
    },
  },
  frontDoor: {
    apiUrl: apiInternalUrl,
    webUrl: webInternalUrl,
  },
});
const server = serve({ fetch: app.fetch, port });

// WebSocket upgrades exist only for the Dashboard dev server's HMR socket;
// agent and API traffic is HTTP/SSE/NDJSON. Pipe upgrades to the web
// upstream raw so `pnpm dev` runs the exact production topology.
server.on("upgrade", (incoming, socket, head) => {
  const target = new URL(webInternalUrl);
  const proxied = httpRequest({
    host: target.hostname,
    port: target.port,
    path: incoming.url,
    method: incoming.method,
    headers: incoming.headers,
  });
  proxied.on("upgrade", (response, upstreamSocket, upstreamHead) => {
    const lines = [`HTTP/1.1 ${response.statusCode} ${response.statusMessage}`];
    for (let i = 0; i < response.rawHeaders.length; i += 2) {
      lines.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`);
    }
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    if (upstreamHead.length) socket.write(upstreamHead);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
    const teardown = () => {
      socket.destroy();
      upstreamSocket.destroy();
    };
    upstreamSocket.on("error", teardown);
    socket.on("error", teardown);
  });
  proxied.on("error", () => socket.destroy());
  if (head.length) proxied.write(head);
  proxied.end();
});

console.log(`${formatBuildInfo(buildInfo)} listening on http://0.0.0.0:${port}`);
platformObservability.emitLog({
  severity: "info",
  eventName: "eveland.gateway.ready",
  body: "Eveland Agent Gateway is ready.",
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
