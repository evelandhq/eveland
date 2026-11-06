import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { injectWorkflowWorld } from "./workflow-world.js";

// The generated root config is what every shared-World Release builds from, so
// it must satisfy the real compiler of the eve window's line. eve 1.0
// only accepts an agent config that carries defineAgent's brand, a
// non-enumerable symbol a plain object (or a spread of a branded one) lacks.
const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const eveLines = [{ name: "eve (1.0.x)", root: "packages/agent-scheduler/node_modules/eve" }];
const worldPackageRoot = path.join(repoRoot, "apps/worker/node_modules/@evelandhq/workflow-world");
const worldConfig = { packageName: "@evelandhq/workflow-world", packageVersion: "0.31.1" };
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.each(eveLines)("the injected workflow-world config builds on $name", ({ root }) => {
  const eveRoot = path.join(repoRoot, root);

  test("when the project has no agent config", async () => {
    const releaseDir = await release(eveRoot, {});
    const result = await injectWorkflowWorld({ releaseDir, config: worldConfig });

    expect(result).toEqual({ agentConfigPath: "agent/agent.ts" });
    await expect(
      readFile(path.join(releaseDir, result.agentConfigPath), "utf8"),
    ).resolves.toContain('world: "@evelandhq/workflow-world"');
    await build(eveRoot, releaseDir);
  }, 120_000);

  test("when the project authored a defineAgent config", async () => {
    const releaseDir = await release(eveRoot, {
      "agent/agent.ts": [
        'import { defineAgent } from "eve";',
        "",
        "// authored",
        'export default defineAgent({ model: "anthropic/claude-sonnet-5" });',
        "",
      ].join("\n"),
    });
    const result = await injectWorkflowWorld({ releaseDir, config: worldConfig });

    expect(result).toEqual({
      agentConfigPath: "agent/agent.ts",
      authoredConfigPath: "agent/eveland-authored-agent.ts",
    });
    await expect(
      readFile(path.join(releaseDir, result.authoredConfigPath!), "utf8"),
    ).resolves.toContain("// authored");
    const generated = await readFile(path.join(releaseDir, result.agentConfigPath), "utf8");
    expect(generated).toContain('from "./eveland-authored-agent.ts"');
    expect(generated).toContain('world: "@evelandhq/workflow-world"');
    await build(eveRoot, releaseDir);
  }, 120_000);
});

test("on eve 1.0 the wrapper does not brand an authored plain-object config eve itself rejects", async () => {
  const eveRoot = path.join(repoRoot, eveLines[0]!.root);
  const releaseDir = await release(eveRoot, {
    "agent/agent.ts": 'export default { model: "anthropic/claude-sonnet-5" };\n',
  });
  await injectWorkflowWorld({ releaseDir, config: worldConfig });

  await expect(build(eveRoot, releaseDir)).rejects.toThrow(/Export defineAgent/);
}, 120_000);

async function release(eveRoot: string, files: Record<string, string>): Promise<string> {
  const releaseDir = await mkdtemp(path.join(os.tmpdir(), "eveland-world-injection-"));
  roots.push(releaseDir);
  const eveVersion = JSON.parse(await readFile(path.join(eveRoot, "package.json"), "utf8")).version;
  await writeFile(
    path.join(releaseDir, "package.json"),
    JSON.stringify({
      name: "world-injection",
      private: true,
      type: "module",
      dependencies: { eve: eveVersion },
    }),
  );
  await mkdir(path.join(releaseDir, "agent"), { recursive: true });
  await writeFile(path.join(releaseDir, "agent/instructions.md"), "World injection fixture.\n");
  for (const [relativePath, content] of Object.entries(files)) {
    await writeFile(path.join(releaseDir, relativePath), content);
  }
  await mkdir(path.join(releaseDir, "node_modules/@evelandhq"), { recursive: true });
  await symlink(eveRoot, path.join(releaseDir, "node_modules/eve"));
  await symlink(worldPackageRoot, path.join(releaseDir, "node_modules/@evelandhq/workflow-world"));
  return releaseDir;
}

async function build(eveRoot: string, releaseDir: string): Promise<void> {
  await execFileAsync(
    process.execPath,
    [path.join(eveRoot, "bin/eve.js"), "build", "--skip-sandbox-prewarm"],
    { cwd: releaseDir, env: { ...process.env, EVE_TELEMETRY_DISABLED: "1" } },
  );
}
