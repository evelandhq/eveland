import { describe, expect, test } from "vitest";

import { safeLoginNextPath } from "./login-next.js";

describe("login next destination", () => {
  test("accepts only safe relative login destinations", () => {
    expect(safeLoginNextPath("/api/identity/continue?state=abc")).toBe(
      "/api/identity/continue?state=abc",
    );
    expect(safeLoginNextPath("//evil.example")).toBe("/projects");
    expect(safeLoginNextPath("https://evil.example")).toBe("/projects");
    expect(safeLoginNextPath(undefined)).toBe("/projects");
  });
});
