import { describe, expect, test } from "vitest";
import { normalizePublicOrigin } from "./public-origin.js";

describe("normalizePublicOrigin", () => {
  test("strips whitespace and trailing slashes", () => {
    expect(normalizePublicOrigin(" https://eve.example.com// ")).toBe("https://eve.example.com");
  });

  test("passes a clean origin through unchanged", () => {
    expect(normalizePublicOrigin("http://localhost:4000")).toBe("http://localhost:4000");
  });

  test("returns null for unset or blank values", () => {
    expect(normalizePublicOrigin(undefined)).toBeNull();
    expect(normalizePublicOrigin(null)).toBeNull();
    expect(normalizePublicOrigin("")).toBeNull();
    expect(normalizePublicOrigin("   ")).toBeNull();
    expect(normalizePublicOrigin("///")).toBeNull();
  });
});
