import { describe, expect, test } from "vitest";

import {
  modelGatewayKindOptions,
  projectModelGatewayKeySummary,
  validateModelGatewayDraft,
} from "./model-gateway";

describe("Model Gateway form", () => {
  test("offers every supported kind, with LiteLLM marked as issuing per-project keys", () => {
    expect(modelGatewayKindOptions.map((option) => option.value)).toEqual([
      "litellm",
      "openrouter",
      "vercel",
      "openai-compatible",
    ]);
    expect(
      modelGatewayKindOptions.find((option) => option.value === "litellm")?.credentialLabel,
    ).toBe("Management key");
  });

  test("requires a credential for a new gateway", () => {
    expect(
      validateModelGatewayDraft(
        { kind: "litellm", baseUrl: "https://llm.example/v1", credential: "" },
        null,
      ),
    ).toEqual({ ok: false, error: "Enter the management key." });
  });

  test("keeps the stored credential when the gateway itself is unchanged", () => {
    expect(
      validateModelGatewayDraft(
        { kind: "litellm", baseUrl: "https://llm.example/v1/", credential: "" },
        { kind: "litellm", baseUrl: "https://llm.example/v1" },
      ),
    ).toEqual({ ok: true, input: { kind: "litellm", baseUrl: "https://llm.example/v1" } });
  });

  test("asks for a new credential when the gateway moves", () => {
    expect(
      validateModelGatewayDraft(
        { kind: "litellm", baseUrl: "https://llm-new.example/v1", credential: "" },
        { kind: "litellm", baseUrl: "https://llm.example/v1" },
      ),
    ).toMatchObject({ ok: false });
  });

  test("needs an http(s) base URL except for AI Gateway", () => {
    expect(
      validateModelGatewayDraft(
        { kind: "openrouter", baseUrl: "openrouter.ai", credential: "k" },
        null,
      ),
    ).toEqual({
      ok: false,
      error: "Enter the gateway's http(s) base URL, such as https://llm.example.com/v1.",
    });
    expect(
      validateModelGatewayDraft({ kind: "vercel", baseUrl: "ignored", credential: "k" }, null),
    ).toEqual({ ok: true, input: { kind: "vercel", credential: "k" } });
  });
});

describe("projectModelGatewayKeySummary", () => {
  test("describes where the project's key comes from", () => {
    expect(
      projectModelGatewayKeySummary(
        { mode: "off", issuedKey: null },
        { kind: "litellm", issuesProjectKeys: true },
      ),
    ).toBe("Not using the platform Model Gateway.");
    expect(
      projectModelGatewayKeySummary(
        { mode: "platform", issuedKey: null },
        { kind: "litellm", issuesProjectKeys: true },
      ),
    ).toBe("A key for this project is issued on its next deploy or restart.");
    expect(
      projectModelGatewayKeySummary(
        {
          mode: "platform",
          issuedKey: {
            alias: "eveland-proj_1",
            state: "registered",
            issuedAt: "2026-11-03T00:00:00.000Z",
          },
        },
        { kind: "litellm", issuesProjectKeys: true },
      ),
    ).toBe("Using its own issued key, eveland-proj_1.");
    expect(
      projectModelGatewayKeySummary(
        { mode: "platform", issuedKey: null },
        { kind: "openrouter", issuesProjectKeys: false },
      ),
    ).toBe("Using the instance's shared key.");
    expect(projectModelGatewayKeySummary({ mode: "platform", issuedKey: null }, null)).toBe(
      "No Model Gateway is configured; Agents call models as authored.",
    );
  });
});
