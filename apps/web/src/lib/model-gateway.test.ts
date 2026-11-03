import { describe, expect, test } from "vitest";

import {
  modelGatewayKindOptions,
  modelGatewayRebuildNotice,
  projectModelGatewaySummary,
  validateModelGatewayDraft,
  validateModelGatewayTest,
} from "./model-gateway";

describe("Model Gateway form", () => {
  test("offers every supported kind", () => {
    expect(modelGatewayKindOptions.map((option) => option.value)).toEqual([
      "litellm",
      "openrouter",
      "vercel",
      "openai-compatible",
    ]);
  });

  test("normalizes the base URL", () => {
    expect(
      validateModelGatewayDraft({ kind: "litellm", baseUrl: " https://llm.example/v1/ " }),
    ).toEqual({ ok: true, input: { kind: "litellm", baseUrl: "https://llm.example/v1" } });
  });

  test("takes no base URL for Vercel AI Gateway", () => {
    expect(validateModelGatewayDraft({ kind: "vercel", baseUrl: "ignored" })).toEqual({
      ok: true,
      input: { kind: "vercel" },
    });
  });

  test("needs an http(s) base URL", () => {
    expect(validateModelGatewayDraft({ kind: "openrouter", baseUrl: "openrouter.ai" })).toEqual({
      ok: false,
      error: "Enter the gateway's http(s) base URL, such as https://llm.example.com/v1.",
    });
  });
});

describe("validateModelGatewayTest", () => {
  test("tests the form's gateway with a key that is entered but never saved", () => {
    expect(
      validateModelGatewayTest({ kind: "litellm", baseUrl: "https://llm.example/v1/" }, " sk-k "),
    ).toEqual({
      ok: true,
      input: { kind: "litellm", baseUrl: "https://llm.example/v1", key: "sk-k" },
    });
    expect(
      validateModelGatewayTest({ kind: "litellm", baseUrl: "https://llm.example/v1" }, ""),
    ).toEqual({ ok: false, error: "Enter a key to test the gateway with." });
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
    expect(
      projectModelGatewaySummary({ mode: "platform" }, { kind: "vercel", baseUrl: null }),
    ).toBe("String model IDs go to Vercel AI Gateway with this project's AI_GATEWAY_API_KEY.");
  });
});

describe("Model Gateway rebuild notice", () => {
  const deployment = (projectName: string, deploymentKey: string) => ({
    projectId: `proj_${projectName}`,
    projectName,
    deploymentId: `dep_${deploymentKey}`,
    deploymentKey,
  });

  test("says nothing when every live deployment picks the gateway up", () => {
    expect(modelGatewayRebuildNotice([], "project")).toBeNull();
    expect(modelGatewayRebuildNotice([], "instance")).toBeNull();
  });

  test("names a project's deployments and says a restart is not enough", () => {
    expect(
      modelGatewayRebuildNotice(
        [deployment("crm", "a1b2c3d4"), deployment("crm", "e5f6g7h8")],
        "project",
      ),
    ).toBe(
      "2 live deployments (a1b2c3d4, e5f6g7h8) still call models as authored: their release was built without the Model Gateway provider. Redeploy on eve 1.0 or later to apply the gateway; a restart does not.",
    );
  });

  test("names the projects across the instance", () => {
    expect(
      modelGatewayRebuildNotice(
        [
          deployment("crm", "a1b2c3d4"),
          deployment("crm", "e5f6g7h8"),
          deployment("ops", "i9j0k1l2"),
        ],
        "instance",
      ),
    ).toBe(
      "3 live deployments in crm, ops still call models as authored: their release was built without the Model Gateway provider. Redeploy those projects on eve 1.0 or later to apply the gateway; a restart does not.",
    );
  });
});
