import { serve } from "@hono/node-server";
import { createModelGatewayApp } from "./app.js";
import { spikeConnectionsFromEnv, spikeResolver } from "./spike-config.js";

/**
 * Spike composition root for manual runs. Phase 2 replaces this with the
 * platform service: encrypted provider connections, RuntimeInstance-bound
 * token verification, the persisted route registry, and observability.
 */
const port = Number(process.env.MODEL_GATEWAY_PORT ?? 4090);

const tokens = new Set(
  (process.env.MODEL_GATEWAY_TOKENS ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== ""),
);
if (tokens.size === 0) {
  throw new Error(
    "MODEL_GATEWAY_TOKENS is required (comma-separated runtime tokens); the model gateway is fail-closed.",
  );
}

const connections = spikeConnectionsFromEnv(process.env);
if (connections.length === 0) {
  throw new Error(
    "No provider key configured: set ZAI_API_KEY and/or DEEPSEEK_API_KEY; the model gateway is fail-closed.",
  );
}

const resolver = spikeResolver(connections);
const app = createModelGatewayApp({
  authenticate: (token) => tokens.has(token),
  resolveModel: resolver.resolveModel,
  listModels: resolver.listModels,
});

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
console.log(
  `eveland model-gateway (spike) listening on http://127.0.0.1:${port} with providers: ${connections
    .map((connection) => connection.id)
    .join(", ")}`,
);
