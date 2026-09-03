import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { defaultTemplateDir, initProject } from "./init.ts";

async function makeTemplate(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "eveland-template-"));
  await mkdir(path.join(dir, "agent"), { recursive: true });
  await writeFile(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "starter-agent", dependencies: { eve: "1.2.3" } }, null, 2)}\n`,
  );
  await writeFile(path.join(dir, "agent", "main.ts"), "export const persona = 'guide';\n");
  return dir;
}

describe("eveland init", () => {
  test("copies the template and names the project after the directory", async () => {
    const templateDir = await makeTemplate();
    const parent = await mkdtemp(path.join(os.tmpdir(), "eveland-init-"));
    const targetDir = path.join(parent, "My Tour_Guide");

    const result = await initProject({ targetDir, templateDir });

    expect(result.projectName).toBe("my-tour-guide");
    expect(result.files).toEqual(["agent/main.ts", "package.json"]);
    const manifest = JSON.parse(await readFile(path.join(targetDir, "package.json"), "utf8"));
    expect(manifest.name).toBe("my-tour-guide");
    // The template's dependency pins survive untouched: CI keeps the in-tree
    // template on the current eve window, so a copy is already correct.
    expect(manifest.dependencies).toEqual({ eve: "1.2.3" });
  });

  test("refuses a non-empty target directory", async () => {
    const templateDir = await makeTemplate();
    const targetDir = await mkdtemp(path.join(os.tmpdir(), "eveland-init-full-"));
    await writeFile(path.join(targetDir, "keep.txt"), "existing work");
    await expect(initProject({ targetDir, templateDir })).rejects.toThrow(/not empty/);
  });

  test("resolves the in-tree template location", () => {
    expect(defaultTemplateDir()).toMatch(/templates[/\\]starter-agent[/\\]$/);
  });
});
