import { describe, expect, test } from "vitest";
import * as Eve from "./eve.js";
import { getEveString, isEveRecord, parseEveJsonObject, parseStepUsageEvent } from "./eve.js";

test("Eve wire helpers parse object payloads", () => {
  const parsed = parseEveJsonObject('{"sessionId":"eve_123","response":"hello"}');

  expect(isEveRecord(parsed)).toBe(true);
  expect(getEveString(parsed, "sessionId")).toBe("eve_123");
  expect(parseEveJsonObject("[]")).toBeNull();
  expect(parseEveJsonObject("not-json")).toBeNull();
});

describe("parseStepUsageEvent", () => {
  test("normalizes provider-reported usage from a completed model step", () => {
    expect(
      parseStepUsageEvent("step.completed", {
        turnId: "turn_2",
        stepIndex: 3,
        finishReason: "stop",
        usage: {
          inputTokens: 120,
          outputTokens: 30,
          cacheReadTokens: 80,
          cacheWriteTokens: 10,
          costUsd: 0.0042,
        },
      }),
    ).toEqual({
      turnId: "turn_2",
      stepIndex: 3,
      finishReason: "stop",
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
      costUsd: 0.0042,
      usageReported: true,
    });
  });

  test("keeps unavailable usage fields distinct from zero", () => {
    expect(
      parseStepUsageEvent("step.completed", {
        turnId: "turn_0",
        stepIndex: 0,
        finishReason: "tool-calls",
        usage: { inputTokens: 42 },
      }),
    ).toEqual({
      turnId: "turn_0",
      stepIndex: 0,
      finishReason: "tool-calls",
      inputTokens: 42,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
      usageReported: true,
    });
  });

  test("records a completed step whose provider omitted usage", () => {
    expect(
      parseStepUsageEvent("step.completed", {
        turnId: "turn_0",
        stepIndex: 0,
        finishReason: "stop",
      }),
    ).toEqual({
      turnId: "turn_0",
      stepIndex: 0,
      finishReason: "stop",
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
      usageReported: false,
    });
  });

  test("ignores events that cannot identify a completed model step", () => {
    expect(parseStepUsageEvent("turn.completed", { turnId: "turn_0", stepIndex: 0 })).toBeNull();
    expect(parseStepUsageEvent("step.completed", { turnId: "turn_0" })).toBeNull();
  });
});

describe("Playground turn validation", () => {
  test("accepts text and safe data-url attachments within the configured limits", () => {
    const validate = (Eve as Record<string, unknown>).validatePlaygroundTurn;
    expect(validate).toBeTypeOf("function");
    if (typeof validate !== "function") return;

    const payload = {
      message: [
        { type: "text", text: "Review these files" },
        {
          type: "file",
          data: "data:text/plain;base64,aGVsbG8=",
          filename: "notes.txt",
          mediaType: "text/plain",
        },
        {
          type: "file",
          data: "data:application/octet-stream;base64,e30=",
          filename: "config.json",
          mediaType: "application/octet-stream",
        },
      ],
    };

    expect(validate(payload, { maxFiles: 4, maxFileBytes: 8, maxTotalFileBytes: 16 })).toEqual(payload);
  });

  test("rejects unsafe file types and attachment count or byte overflows", () => {
    const validate = (Eve as Record<string, unknown>).validatePlaygroundTurn;
    expect(validate).toBeTypeOf("function");
    if (typeof validate !== "function") return;

    const file = {
      type: "file",
      data: "data:text/plain;base64,aGVsbG8=",
      filename: "notes.txt",
      mediaType: "text/plain",
    };

    expect(() => validate({ message: [file, file] }, { maxFiles: 1, maxFileBytes: 8, maxTotalFileBytes: 16 })).toThrow(/at most 1 file/i);
    expect(() => validate({ message: [file] }, { maxFiles: 4, maxFileBytes: 4, maxTotalFileBytes: 16 })).toThrow(/5 bytes.*4 bytes/i);
    expect(() =>
      validate(
        {
          message: [{ ...file, data: "data:application/zip;base64,UEsDBA==", filename: "source.zip", mediaType: "application/zip" }],
        },
        { maxFiles: 4, maxFileBytes: 8, maxTotalFileBytes: 16 },
      ),
    ).toThrow(/not supported/i);
  });

  test("accepts HITL-only continuations but rejects empty turns", () => {
    const validate = (Eve as Record<string, unknown>).validatePlaygroundTurn;
    expect(validate).toBeTypeOf("function");
    if (typeof validate !== "function") return;

    expect(
      validate({ continuationToken: "continue_1", inputResponses: [{ requestId: "request_1", optionId: "approve" }] }),
    ).toMatchObject({ inputResponses: [{ requestId: "request_1", optionId: "approve" }] });
    expect(() => validate({ continuationToken: "continue_1" })).toThrow(/message or input response/i);
    expect(() => validate({ inputResponses: [{ requestId: "request_1", text: "" }] })).toThrow(/option or text value/i);
    expect(() => validate({ inputResponses: [{ requestId: "request_1", optionId: "" }] })).toThrow(/option or text value/i);
  });
});
