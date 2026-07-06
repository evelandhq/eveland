import { describe, expect, test } from "vitest";
import { createId, idAlphabet } from "./ids.js";

describe("createId", () => {
  test("creates prefixed 10 character IDs using the approved alphabet", () => {
    const id = createId("proj");

    expect(id).toMatch(/^proj_[A-Za-z0-9]{10}$/);
    expect([...id.slice("proj_".length)].every((char) => idAlphabet.includes(char))).toBe(true);
  });
});
