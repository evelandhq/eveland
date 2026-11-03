import { MODEL_GATEWAY_ENV } from "@evelandhq/core/model-gateway";
import { describe, expect, test, vi } from "vitest";

import { collectStaticModelIds } from "../runtime/discovery-artifacts.js";
import {
  modelGatewayValidationLog,
  validateModelGatewayModels,
} from "./model-gateway-validation.js";

const active = {
  [MODEL_GATEWAY_ENV.kind]: "litellm",
  [MODEL_GATEWAY_ENV.url]: "https://llm.example/v1",
  [MODEL_GATEWAY_ENV.key]: "sk-project",
};

describe("collectStaticModelIds", () => {
  test("reads the root and subagent models from eve's compiled agent manifest", () => {
    const manifest = {
      config: { model: { id: "anthropic/claude-sonnet-4.5" } },
      subagents: [
        { config: { model: { id: "openai/gpt-5" } } },
        { manifest: { config: { model: { id: "anthropic/claude-sonnet-4.5" } }, subagents: [] } },
        { config: {} },
      ],
    };
    expect(collectStaticModelIds(manifest)).toEqual([
      "anthropic/claude-sonnet-4.5",
      "openai/gpt-5",
    ]);
  });

  test("finds nothing to check in a manifest it does not recognize", () => {
    expect(collectStaticModelIds(undefined)).toEqual([]);
    expect(collectStaticModelIds({ config: { dynamicModel: true } })).toEqual([]);
  });
});

describe("validateModelGatewayModels", () => {
  test("skips a project that uses no Model Gateway", async () => {
    const listModels = vi.fn();
    await expect(
      validateModelGatewayModels({
        env: { ...active, [MODEL_GATEWAY_ENV.kind]: "" },
        modelIds: ["a/b"],
        listModels,
      }),
    ).resolves.toEqual({ status: "skipped" });
    expect(listModels).not.toHaveBeenCalled();
  });

  test("checks the models with the project's own key", async () => {
    const listModels = vi.fn(async () => ["anthropic/claude-sonnet-4.5"]);
    await expect(
      validateModelGatewayModels({
        env: active,
        modelIds: ["anthropic/claude-sonnet-4.5"],
        listModels,
      }),
    ).resolves.toEqual({ status: "ok", checked: ["anthropic/claude-sonnet-4.5"] });
    expect(listModels).toHaveBeenCalledWith({
      baseUrl: "https://llm.example/v1",
      apiKey: "sk-project",
    });
  });

  test("lists AI Gateway's own models for the vercel kind", async () => {
    const listModels = vi.fn(async () => ["anthropic/claude-sonnet-4.5"]);
    await validateModelGatewayModels({
      env: {
        [MODEL_GATEWAY_ENV.kind]: "vercel",
        [MODEL_GATEWAY_ENV.url]: "",
        [MODEL_GATEWAY_ENV.key]: "vck",
      },
      modelIds: ["anthropic/claude-sonnet-4.5"],
      listModels,
    });
    expect(listModels).toHaveBeenCalledWith({
      baseUrl: "https://ai-gateway.vercel.sh/v1",
      apiKey: "vck",
    });
  });

  test("names each missing model with the closest IDs the gateway does offer", async () => {
    const result = await validateModelGatewayModels({
      env: active,
      modelIds: ["anthropic/claude-sonnet-4.5", "openai/gpt-5"],
      listModels: async () => [
        "anthropic/claude-sonnet-4-5",
        "anthropic/claude-opus-4.1",
        "openai/gpt-5",
      ],
    });
    expect(result).toEqual({
      status: "missing",
      missing: [
        { id: "anthropic/claude-sonnet-4.5", suggestions: ["anthropic/claude-sonnet-4-5"] },
      ],
    });
    expect(modelGatewayValidationLog(result).join("\n")).toMatch(
      /anthropic\/claude-sonnet-4\.5 .*not offered.*did you mean anthropic\/claude-sonnet-4-5/,
    );
  });

  test("warns instead of failing when the gateway cannot list its models", async () => {
    const result = await validateModelGatewayModels({
      env: active,
      modelIds: ["anthropic/claude-sonnet-4.5"],
      listModels: async () => {
        throw new Error("Model Gateway responded with HTTP 503");
      },
    });
    expect(result).toEqual({
      status: "unavailable",
      error: "Model Gateway responded with HTTP 503",
    });
    expect(modelGatewayValidationLog(result)).toEqual([
      "WARNING: could not check the Agent's models against the Model Gateway (Model Gateway responded with HTTP 503); deploying anyway.",
    ]);
  });
});
