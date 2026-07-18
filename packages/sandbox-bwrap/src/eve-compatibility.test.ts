import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { SandboxBackend as Eve024SandboxBackend } from "eve-0-24/sandbox";
import { createBwrapSandboxBackend } from "./backend.js";

describe("published Eve compatibility", () => {
  test("pins the latest Eve patch and advertises the verified two-minor window", async () => {
    const packageJson = JSON.parse(
      await readFile(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
    ) as {
      devDependencies: { eve: string; "eve-0-24": string };
      peerDependencies: { eve: string };
    };

    expect(packageJson.devDependencies.eve).toBe("0.25.1");
    expect(packageJson.devDependencies["eve-0-24"]).toBe("npm:eve@0.24.6");
    expect(packageJson.peerDependencies.eve).toBe(">=0.24.0 <0.26.0");
  });

  test("the backend remains structurally compatible with Eve 0.24", () => {
    const legacyBackend: Eve024SandboxBackend = createBwrapSandboxBackend();

    expect(legacyBackend.name).toBe("bwrap");
  });
});
