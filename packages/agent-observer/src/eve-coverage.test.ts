import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const fixtureDir = path.resolve(import.meta.dirname, "../fixtures/eve-0.22.1-hooks");
const eveBin = path.resolve(import.meta.dirname, "../node_modules/.bin/eve");

describe("Eve 0.22.1 observer hook coverage", () => {
  test("directory-form subagents expose their own hook slot while file-form and remote subagents do not", async () => {
    const { stdout } = await execFileAsync(eveBin, ["info", "--json"], { cwd: fixtureDir });
    const info = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
      artifacts: { discoveryManifest: string };
    };
    const manifest = JSON.parse(await readFile(info.artifacts.discoveryManifest, "utf8")) as {
      hooks: Array<{ logicalPath: string }>;
      subagents: Array<{
        subagentId: string;
        manifest: { hooks: Array<{ logicalPath: string }> };
      }>;
    };

    expect(manifest.hooks.map((hook) => hook.logicalPath)).toContain("hooks/root-observer.ts");
    expect(manifest.subagents.map((subagent) => subagent.subagentId)).toEqual([
      "directory-child",
      "file-child",
      "remote-child",
    ]);
    expect(
      manifest.subagents
        .find((subagent) => subagent.subagentId === "directory-child")
        ?.manifest.hooks.map((hook) => hook.logicalPath),
    ).toContain(
      "hooks/child-observer.ts",
    );
    expect(manifest.subagents.find((subagent) => subagent.subagentId === "file-child")?.manifest.hooks ?? []).toEqual([]);
    expect(manifest.subagents.find((subagent) => subagent.subagentId === "remote-child")?.manifest.hooks ?? []).toEqual([]);
  });
});
