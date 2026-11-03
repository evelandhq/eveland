import { MODEL_GATEWAY_ENV } from "@evelandhq/core/model-gateway";
import { createTestStore } from "@evelandhq/db/vitest";
import { describe, expect, test } from "vitest";

import { resolveModelGatewayEnvironment } from "./model-gateway-environment.js";

const inactive = { [MODEL_GATEWAY_ENV.kind]: "", [MODEL_GATEWAY_ENV.url]: "" };

describe("resolveModelGatewayEnvironment", () => {
  test("reserves the names with empty values when no Model Gateway is configured", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "no-gateway", importKind: "zip" });

    await expect(resolveModelGatewayEnvironment(store, project.id)).resolves.toEqual(inactive);
  });

  test("points a project at the instance's gateway, and nothing else", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "gateway", importKind: "zip" });
    await store.saveModelGateway({ kind: "litellm", baseUrl: "https://llm.example/v1" });

    const env = await resolveModelGatewayEnvironment(store, project.id);
    expect(env).toEqual({
      EVELAND_MODEL_GATEWAY_KIND: "litellm",
      EVELAND_MODEL_GATEWAY_URL: "https://llm.example/v1",
    });
    // The key is the project's own AI_GATEWAY_API_KEY; Eveland never supplies one.
    expect(env).not.toHaveProperty(MODEL_GATEWAY_ENV.key);
  });

  test("reserves empty values for a project that opted out", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "opted-out", importKind: "zip" });
    await store.saveModelGateway({ kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1" });
    await store.saveProjectModelGatewayMode(project.id, "off");

    await expect(resolveModelGatewayEnvironment(store, project.id)).resolves.toEqual(inactive);
  });

  test("leaves the URL empty for Vercel AI Gateway, whose address is fixed", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "vercel-gateway", importKind: "zip" });
    await store.saveModelGateway({ kind: "vercel", baseUrl: null });

    await expect(resolveModelGatewayEnvironment(store, project.id)).resolves.toEqual({
      EVELAND_MODEL_GATEWAY_KIND: "vercel",
      EVELAND_MODEL_GATEWAY_URL: "",
    });
  });
});
