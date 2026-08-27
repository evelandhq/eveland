import { platformObservability } from "./observability.js";
import { serve } from "@hono/node-server";
import { formatBuildInfo } from "@evelandhq/core/build-info";
import { createBuildInfoFromEnv } from "@evelandhq/core/server/build-info";
import { resolveSecretWithDevFallback } from "@evelandhq/core/server/dev-secrets";
import { createStoreFromEnv } from "@evelandhq/db/factory";
import { createModelGatewayApp } from "./app.js";
import { createModelGatewayAuthenticator } from "./instance-token-auth.js";
import { createStoreBackedModelRegistry } from "./store-registry.js";

/**
 * The Model Gateway data plane: authenticates instance tokens and personal
 * API keys against the Store, resolves canonical model ids through the
 * Store-backed BYOK registry, and replays calls to the configured providers.
 *
 * Private by design: bind loopback on a bare host; in Compose the container
 * binds 0.0.0.0 and privacy comes from the 127.0.0.1-only port publish plus
 * the absence of any public route.
 */
const port = Number(process.env.MODEL_GATEWAY_PORT ?? 4090);
const host = process.env.MODEL_GATEWAY_HOST ?? "127.0.0.1";
const buildInfo = createBuildInfoFromEnv("model-gateway", process.env);

const secretKey = resolveSecretWithDevFallback(
  process.env,
  process.env.EVELAND_MODEL_GATEWAY_SECRET_KEY,
  // Exactly 32 bytes, as the AES-256-GCM envelope requires.
  "eveland-dev-model-gateway-key-00",
);
if (!secretKey) {
  throw new Error(
    "EVELAND_MODEL_GATEWAY_SECRET_KEY is required unless NODE_ENV is explicitly development.",
  );
}

const { store, close } = createStoreFromEnv();
const registry = createStoreBackedModelRegistry({ store, secretKey });
const app = createModelGatewayApp({
  authenticate: createModelGatewayAuthenticator(store),
  resolveModel: registry.resolveModel,
  listModels: registry.listModels,
  maxConcurrentPerSubject: Number(process.env.MODEL_GATEWAY_MAX_CONCURRENT_PER_SUBJECT ?? 8),
});

const server = serve({ fetch: app.fetch, port, hostname: host });
console.log(`${formatBuildInfo(buildInfo)} model-gateway listening on http://${host}:${port}`);
platformObservability.emitLog({
  severity: "info",
  eventName: "eveland.model-gateway.ready",
  body: `model-gateway listening on ${host}:${port}`,
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => {
      void Promise.all([close(), platformObservability.shutdown()]).finally(() => process.exit(0));
    });
  });
}
