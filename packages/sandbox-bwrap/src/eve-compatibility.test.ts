import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { SandboxBackend as Eve027SandboxBackend } from "eve-0-27/sandbox";
import { createBwrapSandboxBackend } from "./backend.js";

describe("published Eve compatibility", () => {
  test("pins the latest Eve patch and advertises the verified three-minor window", async () => {
    const packageJson = JSON.parse(
      await readFile(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
    ) as {
      devDependencies: { eve: string; "eve-0-27": string; "eve-0-28": string };
      peerDependencies: { eve: string };
    };

    expect(packageJson.devDependencies.eve).toBe("0.29.4");
    expect(packageJson.devDependencies["eve-0-27"]).toBe("npm:eve@0.27.13");
    expect(packageJson.devDependencies["eve-0-28"]).toBe("npm:eve@0.28.0");
    expect(packageJson.peerDependencies.eve).toBe(">=0.27.0 <0.30.0");
  });

  test("the backend remains structurally compatible with Eve 0.27", () => {
    const legacyBackend: Eve027SandboxBackend = createBwrapSandboxBackend();

    expect(legacyBackend.name).toBe("bwrap");
  });
});
