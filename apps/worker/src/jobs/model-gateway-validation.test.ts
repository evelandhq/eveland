import { MODEL_GATEWAY_ENV } from "@evelandhq/core/model-gateway";
import { ModelGatewayRequestError } from "@evelandhq/core/server/model-gateway-client";
import { describe, expect, test, vi } from "vitest";

import compiledManifest from "../runtime/__fixtures__/compiled-agent-manifest.eve-1.0.0-rc.1.json" with { type: "json" };
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
  // Trimmed from a real `eve build` (eve 1.0.0-rc.1) of an Agent whose root
  // names "vendor/root" with compaction model "vendor/compact", and whose
  // subagents are: child ("vendor/child"), its nested grand ("vendor/grand"),
  // custom (an authored model object with provider "custom.chat"), and gw (an
  // authored model object with provider "gateway"). eve flattens nested
  // subagents into one list and keeps each one's config under `agent`.
  test("reads every string model from eve's compiled agent manifest", () => {
    expect(collectStaticModelIds(compiledManifest)).toEqual([
      "vendor/root",
      "vendor/compact",
      "vendor/child",
      "vendor/grand",
    ]);
  });

  test("leaves out authored model objects, which never call the injected provider", () => {
    // Both carry a `source`: eve loads the object from the Agent's module and
    // calls it directly, whether its provider is external or AI Gateway.
    const ids = collectStaticModelIds(compiledManifest);
    expect(ids).not.toContain("custom/private-model");
    expect(ids).not.toContain("gateway/vendor/gw-object");
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

  test("lists Vercel AI Gateway's models at its fixed address for the vercel kind", async () => {
    const listModels = vi.fn(async () => ["anthropic/claude-sonnet-4.5"]);
    await expect(
      validateModelGatewayModels({
        env: {
          [MODEL_GATEWAY_ENV.kind]: "vercel",
          [MODEL_GATEWAY_ENV.url]: "",
          [MODEL_GATEWAY_ENV.key]: "vck",
        },
        modelIds: ["anthropic/claude-sonnet-4.5"],
        listModels,
      }),
    ).resolves.toEqual({ status: "ok", checked: ["anthropic/claude-sonnet-4.5"] });
    expect(listModels).toHaveBeenCalledWith({
      baseUrl: "https://ai-gateway.vercel.sh/v1",
      apiKey: "vck",
    });
  });

  test("cannot check without the project's key, and only warns: the call fails on its own", async () => {
    const listModels = vi.fn();
    const result = await validateModelGatewayModels({
      env: { ...active, [MODEL_GATEWAY_ENV.key]: "" },
      modelIds: ["anthropic/claude-sonnet-4.5"],
      listModels,
    });
    expect(result).toEqual({ status: "no-key", baseUrl: "https://llm.example/v1" });
    expect(listModels).not.toHaveBeenCalled();
    expect(modelGatewayValidationLog(result)).toEqual([
      "WARNING: AI_GATEWAY_API_KEY is not set, so model calls to the Model Gateway at https://llm.example/v1 will fail. Set it in the project's environment.",
    ]);
  });

  test("reports a key the gateway rejects, naming the gateway", async () => {
    const result = await validateModelGatewayModels({
      env: active,
      modelIds: ["anthropic/claude-sonnet-4.5"],
      listModels: async () => {
        throw new ModelGatewayRequestError("Model Gateway responded with HTTP 401", 401);
      },
    });
    expect(result).toEqual({ status: "rejected", baseUrl: "https://llm.example/v1" });
    expect(modelGatewayValidationLog(result)).toEqual([
      "ERROR: the Model Gateway at https://llm.example/v1 rejected this project's AI_GATEWAY_API_KEY (HTTP 401). Set a key issued by that gateway, or opt the project out of the Model Gateway.",
    ]);
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
      baseUrl: "https://llm.example/v1",
      missing: [
        { id: "anthropic/claude-sonnet-4.5", suggestions: ["anthropic/claude-sonnet-4-5"] },
      ],
    });
    expect(modelGatewayValidationLog(result).join("\n")).toMatch(
      /anthropic\/claude-sonnet-4\.5 .*not offered by the Model Gateway at https:\/\/llm\.example\/v1 .*did you mean anthropic\/claude-sonnet-4-5/,
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
      baseUrl: "https://llm.example/v1",
      error: "Model Gateway responded with HTTP 503",
    });
    expect(modelGatewayValidationLog(result)).toEqual([
      "WARNING: could not check the Agent's models against the Model Gateway at https://llm.example/v1 (Model Gateway responded with HTTP 503); deploying anyway.",
    ]);
  });
});
