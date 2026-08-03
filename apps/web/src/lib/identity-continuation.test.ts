import { describe, expect, test } from "vitest";

import {
  buildIdentityInternalContinuationUrl,
  safeLoginNextPath,
} from "./identity-continuation.js";

describe("Identity login continuation", () => {
  test("accepts only safe relative login destinations", () => {
    expect(safeLoginNextPath("/identity/internal/continue?state=abc")).toBe(
      "/identity/internal/continue?state=abc",
    );
    expect(safeLoginNextPath("//evil.example")).toBe("/projects");
    expect(safeLoginNextPath("https://evil.example")).toBe("/projects");
    expect(safeLoginNextPath(undefined)).toBe("/projects");
  });

  test("sends only the opaque state to the configured Eveland API", () => {
    expect(buildIdentityInternalContinuationUrl("opaque-state", "https://api.example.com/")).toBe(
      "https://api.example.com/identity/internal/continue?state=opaque-state",
    );
    expect(() => buildIdentityInternalContinuationUrl(" ", "https://api.example.com")).toThrow(
      /state/i,
    );
  });
});
