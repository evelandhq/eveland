import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { SandboxBackend as Eve024SandboxBackend } from "eve-0-24/sandbox";
import { createBwrapSandboxBackend } from "./backend.js";

describe("published Eve compatibility", () => {
  test("pins the latest Eve patch and advertises the verified three-minor window", async () => {
    const packageJson = JSON.parse(
      await readFile(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
    ) as {
      devDependencies: { eve: string; "eve-0-24": string; "eve-0-25": string };
      peerDependencies: { eve: string };
    };

    expect(packageJson.devDependencies.eve).toBe("0.26.2");
    expect(packageJson.devDependencies["eve-0-24"]).toBe("npm:eve@0.24.6");
    expect(packageJson.devDependencies["eve-0-25"]).toBe("npm:eve@0.25.3");
    expect(packageJson.peerDependencies.eve).toBe(">=0.24.0 <0.27.0");
  });

  test("the backend remains structurally compatible with Eve 0.24", () => {
    const legacyBackend: Eve024SandboxBackend = createBwrapSandboxBackend();

    expect(legacyBackend.name).toBe("bwrap");
  });
});
