import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createGateway } from "@ai-sdk/gateway";
import { streamText } from "ai";
import { createModelGatewayApp } from "./app.js";
import { spikeConnectionsFromEnv, spikeResolver } from "./spike-config.js";

/**
 * Optional live smoke against real providers (never part of CI): starts the
 * model gateway in-process and streams one completion per configured
 * provider through the real @ai-sdk/gateway client.
 *
 *   ZAI_API_KEY=... DEEPSEEK_API_KEY=... pnpm --filter @evelandhq/model-gateway smoke:live
 *
 * Model ids can be overridden: MODEL_GATEWAY_SMOKE_MODELS="zai/glm-5.3-flash,deepseek/deepseek-chat"
 */
const connections = spikeConnectionsFromEnv(process.env);
if (connections.length === 0) {
  console.log("live smoke skipped: set ZAI_API_KEY and/or DEEPSEEK_API_KEY to run it");
  process.exit(0);
}

const defaultModels: Record<string, string> = {
  zai: "zai/glm-5.3-flash",
  deepseek: "deepseek/deepseek-chat",
};
const models = (process.env.MODEL_GATEWAY_SMOKE_MODELS ?? "")
  .split(",")
  .map((model) => model.trim())
  .filter((model) => model !== "");
const smokeModels =
  models.length > 0
    ? models
    : connections.map((connection) => defaultModels[connection.id]).filter((m) => m !== undefined);

const token = "live-smoke-runtime-token";
const resolver = spikeResolver(connections);
const app = createModelGatewayApp({
  authenticate: (candidate) => candidate === token,
  resolveModel: resolver.resolveModel,
  listModels: resolver.listModels,
});
const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
await new Promise<void>((resolve) => server.on("listening", () => resolve()));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const gateway = createGateway({ baseURL: `${origin}/v4/ai`, apiKey: token });

let failed = false;
for (const modelId of smokeModels) {
  process.stdout.write(`\n=== ${modelId} ===\n`);
  try {
    const result = streamText({
      model: gateway.languageModel(modelId),
      prompt: "Reply with one short sentence: what model are you?",
    });
    for await (const delta of result.textStream) process.stdout.write(delta);
    const usage = await result.usage;
    process.stdout.write(
      `\n-- usage: input=${usage.inputTokens ?? "?"} output=${usage.outputTokens ?? "?"}\n`,
    );
  } catch (error) {
    failed = true;
    console.error(`FAILED: ${modelId}:`, error);
  }
}

server.close();
process.exit(failed ? 1 : 0);
