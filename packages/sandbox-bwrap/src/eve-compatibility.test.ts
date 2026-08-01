import { describe, expect, test } from "vitest";
import type { SandboxBackend as OldestEveSandboxBackend } from "eve-oldest/sandbox";
import { createBwrapSandboxBackend } from "./backend.js";

describe("published Eve compatibility", () => {
  test("the backend remains structurally compatible with the oldest verified Eve line", () => {
    const legacyBackend: OldestEveSandboxBackend = createBwrapSandboxBackend();

    expect(legacyBackend.name).toBe("bwrap");
  });
});
