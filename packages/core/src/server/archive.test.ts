import { describe, expect, test } from "vitest";
import { assertSafeArchivePath, normalizeArchivePath } from "./archive.js";

describe("archive path safety", () => {
  test("normalizes safe relative paths", () => {
    expect(normalizeArchivePath("./agent//tools/get_weather.ts")).toBe(
      "agent/tools/get_weather.ts",
    );
  });

  test("rejects absolute and parent traversal paths", () => {
    expect(() => assertSafeArchivePath("/tmp/agent.ts")).toThrow(/unsafe archive path/i);
    expect(() => assertSafeArchivePath("../agent.ts")).toThrow(/unsafe archive path/i);
    expect(() => assertSafeArchivePath("agent/../../.env")).toThrow(/unsafe archive path/i);
  });

  test("rejects Windows drive and backslash traversal paths", () => {
    expect(() => assertSafeArchivePath("C:\\agent\\instructions.md")).toThrow(
      /unsafe archive path/i,
    );
    expect(() => assertSafeArchivePath("agent\\..\\.env")).toThrow(/unsafe archive path/i);
  });
});
