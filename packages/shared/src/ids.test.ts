import { describe, expect, test } from "vitest";
import { createId, idAlphabet, projectIdFromShortId, projectShortId } from "./ids.js";

describe("createId", () => {
  test("creates prefixed 10 character IDs using the approved alphabet", () => {
    const id = createId("proj");

    expect(id).toMatch(/^proj_[A-Za-z0-9]{10}$/);
    expect([...id.slice("proj_".length)].every((char) => idAlphabet.includes(char))).toBe(true);
  });
});

describe("project short ids", () => {
  test("round-trips a generated project id", () => {
    const id = createId("proj");
    const shortId = projectShortId(id);

    expect(shortId).not.toContain("_");
    expect(projectIdFromShortId(shortId)).toBe(id);
  });

  test("rejects values that cannot be a short id", () => {
    expect(projectIdFromShortId("proj_abc123")).toBeNull();
    expect(projectIdFromShortId("abc/../etc")).toBeNull();
    expect(projectIdFromShortId("")).toBeNull();
  });
});
