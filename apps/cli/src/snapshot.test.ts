import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { collectProjectFiles } from "./snapshot.js";

describe("local deployment snapshot", () => {
  test("uses .evelandignore before .vercelignore and .gitignore", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eveland-cli-ignore-"));
    await Promise.all([
      writeFile(path.join(root, "agent.ts"), "export const agent = true;\n"),
      writeFile(path.join(root, "git-only.txt"), "git\n"),
      writeFile(path.join(root, "vercel-only.txt"), "vercel\n"),
      writeFile(path.join(root, "eveland-only.txt"), "eveland\n"),
      writeFile(path.join(root, ".gitignore"), "git-only.txt\n"),
      writeFile(path.join(root, ".vercelignore"), "vercel-only.txt\n"),
      writeFile(path.join(root, ".evelandignore"), "eveland-only.txt\n"),
    ]);

    const snapshot = await collectProjectFiles(root);

    expect(snapshot.ignoreFile).toBe(".evelandignore");
    expect(snapshot.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(["agent.ts", "git-only.txt", "vercel-only.txt"]),
    );
    expect(snapshot.files.map((file) => file.path)).not.toContain("eveland-only.txt");
  });

  test("includes working-tree files while enforcing non-negatable secret exclusions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eveland-cli-files-"));
    await mkdir(path.join(root, ".git"));
    await mkdir(path.join(root, ".eveland"));
    await mkdir(path.join(root, "node_modules"));
    await Promise.all([
      writeFile(path.join(root, "untracked.ts"), "export default 1;\n"),
      writeFile(path.join(root, ".env"), "OPENAI_API_KEY=secret\n"),
      writeFile(path.join(root, ".env.production"), "TOKEN=secret\n"),
      writeFile(path.join(root, ".env.example"), "OPENAI_API_KEY=\n"),
      writeFile(path.join(root, ".npmrc"), "//registry/:_authToken=secret\n"),
      writeFile(path.join(root, ".git", "config"), "secret\n"),
      writeFile(path.join(root, ".eveland", "project.json"), "{}\n"),
      writeFile(path.join(root, "node_modules", "dependency.js"), "ignored\n"),
      writeFile(
        path.join(root, ".evelandignore"),
        "!.env\n!.env.production\n!.npmrc\n!.git/config\n!.eveland/project.json\n",
      ),
    ]);
    await symlink(path.join(root, ".env"), path.join(root, "linked-config.txt"));

    const snapshot = await collectProjectFiles(root);
    const files = snapshot.files.map((file) => file.path);

    expect(files).toContain("untracked.ts");
    expect(files).toContain(".env.example");
    for (const excluded of [
      ".env",
      ".env.production",
      ".npmrc",
      ".git/config",
      ".eveland/project.json",
      "linked-config.txt",
      "node_modules/dependency.js",
    ]) {
      expect(files).not.toContain(excluded);
    }
  });

  test("rejects a symlink that escapes the project root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eveland-cli-symlink-"));
    const outside = path.join(path.dirname(root), "outside-secret.txt");
    await writeFile(outside, "secret\n");
    await symlink(outside, path.join(root, "linked-secret.txt"));

    await expect(collectProjectFiles(root)).rejects.toThrow(
      "Symlink escapes the project root: linked-secret.txt",
    );
  });
});
