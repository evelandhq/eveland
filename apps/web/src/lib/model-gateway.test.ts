import { describe, expect, test } from "vitest";

import {
  modelGatewayKindOptions,
  projectModelGatewaySummary,
  validateModelGatewayDraft,
} from "./model-gateway";

describe("Model Gateway form", () => {
  test("offers every supported kind", () => {
    expect(modelGatewayKindOptions.map((option) => option.value)).toEqual([
      "litellm",
      "openrouter",
      "openai-compatible",
    ]);
  });

  test("normalizes the base URL", () => {
    expect(
      validateModelGatewayDraft({ kind: "litellm", baseUrl: " https://llm.example/v1/ " }),
    ).toEqual({ ok: true, input: { kind: "litellm", baseUrl: "https://llm.example/v1" } });
  });

  test("needs an http(s) base URL", () => {
    expect(validateModelGatewayDraft({ kind: "openrouter", baseUrl: "openrouter.ai" })).toEqual({
      ok: false,
      error: "Enter the gateway's http(s) base URL, such as https://llm.example.com/v1.",
    });
  });
});

describe("projectModelGatewaySummary", () => {
  test("says where the project's string model IDs go and which key they carry", () => {
    expect(projectModelGatewaySummary({ mode: "platform" }, null)).toBe(
      "No Model Gateway is configured; Agents call models as authored.",
    );
    expect(
      projectModelGatewaySummary(
        { mode: "off" },
        { kind: "litellm", baseUrl: "https://llm.example/v1" },
      ),
    ).toBe("Not using the Model Gateway; Agents call models as authored.");
    expect(
      projectModelGatewaySummary(
        { mode: "platform" },
        { kind: "litellm", baseUrl: "https://llm.example/v1" },
      ),
    ).toBe(
      "String model IDs go to LiteLLM at https://llm.example/v1 with this project's AI_GATEWAY_API_KEY.",
    );
  });
});
