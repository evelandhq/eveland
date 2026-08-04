import { describe, expect, test } from "vitest";
import { createModelCallCapture, type ModelCallCapture } from "./model-capture.js";

type Target = { AI_SDK_TELEMETRY_INTEGRATIONS?: Array<Record<string, unknown>> };

function installedCapture(target: Target = {}): {
  capture: ModelCallCapture;
  onStepEnd: (event: unknown) => void;
} {
  const capture = createModelCallCapture(target);
  capture.install();
  const integration = target.AI_SDK_TELEMETRY_INTEGRATIONS?.[0];
  if (!integration) throw new Error("Capture did not register an integration.");
  return { capture, onStepEnd: integration.onStepEnd as (event: unknown) => void };
}

function stepEnd(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: { provider: "gateway", modelId: "openai/gpt-6" },
    response: { modelId: "gpt-6-2026-01-01" },
    usage: { inputTokens: 120, outputTokens: 30 },
    finishReason: "tool-calls",
    ...overrides,
  };
}

describe("model call capture", () => {
  test("registers exactly one integration in the AI SDK global array", () => {
    const target: Target = {};
    const capture = createModelCallCapture(target);
    capture.install();
    capture.install();
    expect(target.AI_SDK_TELEMETRY_INTEGRATIONS).toHaveLength(1);
  });

  test("appends alongside integrations registered by others", () => {
    const target: Target = { AI_SDK_TELEMETRY_INTEGRATIONS: [{ onStart: () => {} }] };
    installedCapture(target);
    expect(target.AI_SDK_TELEMETRY_INTEGRATIONS).toHaveLength(2);
  });

  test("takes the call whose usage matches the step event, once", () => {
    const { capture, onStepEnd } = installedCapture();
    onStepEnd(stepEnd({ usage: { inputTokens: 999, outputTokens: 1 }, finishReason: "stop" }));
    onStepEnd(stepEnd());

    const observed = capture.take({
      inputTokens: 120,
      outputTokens: 30,
      finishReason: "tool-calls",
    });

    expect(observed).toEqual({
      modelId: "openai/gpt-6",
      responseModelId: "gpt-6-2026-01-01",
      inputTokens: 120,
      outputTokens: 30,
      finishReason: "tool-calls",
    });
    expect(
      capture.take({ inputTokens: 120, outputTokens: 30, finishReason: "tool-calls" }),
    ).toBeUndefined();
  });

  test("normalizes AI SDK finish reasons the way Eve does before comparing", () => {
    const { capture, onStepEnd } = installedCapture();
    onStepEnd(stepEnd({ finishReason: "unknown" }));

    expect(capture.take({ inputTokens: 120, outputTokens: 30, finishReason: "other" })).toEqual(
      expect.objectContaining({ modelId: "openai/gpt-6" }),
    );
  });

  test("a usage-bearing step never takes a call with different usage", () => {
    const { capture, onStepEnd } = installedCapture();
    // A compaction call: real, but not this step's.
    onStepEnd(stepEnd({ usage: { inputTokens: 50_000, outputTokens: 800 } }));

    expect(
      capture.take({ inputTokens: 12, outputTokens: 3, finishReason: "stop" }),
    ).toBeUndefined();
    // The unmatched call is still there for its own step.
    expect(
      capture.take({ inputTokens: 50_000, outputTokens: 800, finishReason: "tool-calls" }),
    ).toEqual(expect.objectContaining({ modelId: "openai/gpt-6" }));
  });

  test("a step without usage falls back to the newest call", () => {
    const { capture, onStepEnd } = installedCapture();
    onStepEnd(stepEnd({ model: { modelId: "openai/gpt-5" }, usage: undefined }));
    onStepEnd(stepEnd({ usage: undefined }));

    expect(
      capture.take({ inputTokens: undefined, outputTokens: undefined, finishReason: undefined }),
    ).toEqual(expect.objectContaining({ modelId: "openai/gpt-6" }));
  });

  test("evicts the oldest calls beyond the buffer bound", () => {
    const { capture, onStepEnd } = installedCapture();
    for (let index = 0; index <= 16; index += 1) {
      onStepEnd(stepEnd({ usage: { inputTokens: index, outputTokens: index } }));
    }

    expect(
      capture.take({ inputTokens: 0, outputTokens: 0, finishReason: "tool-calls" }),
    ).toBeUndefined();
    expect(capture.take({ inputTokens: 16, outputTokens: 16, finishReason: "tool-calls" })).toEqual(
      expect.objectContaining({ inputTokens: 16 }),
    );
  });

  test("ignores events that name no model", () => {
    const { capture, onStepEnd } = installedCapture();
    onStepEnd(stepEnd({ model: {} }));

    expect(
      capture.take({ inputTokens: 120, outputTokens: 30, finishReason: "tool-calls" }),
    ).toBeUndefined();
  });

  test("swallows anything the AI SDK throws at it", () => {
    const { onStepEnd } = installedCapture();
    const hostile = new Proxy(
      {},
      {
        get(): never {
          throw new Error("hostile event");
        },
      },
    );

    expect(() => onStepEnd(null)).not.toThrow();
    expect(() => onStepEnd("text")).not.toThrow();
    expect(() => onStepEnd(hostile)).not.toThrow();
  });

  test("install survives a frozen registry target", () => {
    const target: Target = {};
    Object.freeze(target);
    const capture = createModelCallCapture(target);

    expect(() => capture.install()).not.toThrow();
    expect(
      capture.take({ inputTokens: 120, outputTokens: 30, finishReason: "tool-calls" }),
    ).toBeUndefined();
  });
});
