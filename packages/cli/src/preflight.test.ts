import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { collectProjectFiles, eveSpecifierProblem, MAX_TEXT_FILE_BYTES } from "./preflight.ts";
import { createZipArchive } from "./zip.ts";

const execFileAsync = promisify(execFile);
const WINDOW = ["0.45.x", "0.47.x"];

async function makeProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "eveland-preflight-"));
  await mkdir(path.join(root, "agent"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "junk"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "probe", dependencies: { eve: "0.47.6" } }),
  );
  await writeFile(path.join(root, "agent", "instructions.md"), "Be helpful.");
  await writeFile(path.join(root, "node_modules", "junk", "big.js"), "ignored");
  await writeFile(path.join(root, ".env.example"), "MY_KEY=");
  await writeFile(path.join(root, ".DS_Store"), "junk");
  return root;
}

describe("deploy preflight", () => {
  test("collects the importable tree and reads the manifest", async () => {
    const root = await makeProject();
    const result = await collectProjectFiles(root);
    expect(result.files.map((file) => file.name)).toEqual([
      ".env.example",
      "agent/instructions.md",
      "package.json",
    ]);
    expect(result.eveSpecifier).toBe("0.47.6");
    expect(result.projectName).toBe("probe");
    expect(result.problems).toEqual([]);
  });

  test("flags binaries, oversized files, and missing instructions", async () => {
    const root = await makeProject();
    await writeFile(path.join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    await writeFile(path.join(root, "agent", "big.md"), "x".repeat(MAX_TEXT_FILE_BYTES + 1));
    const result = await collectProjectFiles(root);
    expect(result.problems.join("\n")).toContain("logo.png is a binary file");
    expect(result.problems.join("\n")).toContain("agent/big.md");

    const bare = await mkdtemp(path.join(os.tmpdir(), "eveland-bare-"));
    await writeFile(path.join(bare, "package.json"), JSON.stringify({ dependencies: {} }));
    const bareResult = await collectProjectFiles(bare);
    expect(bareResult.problems.join("\n")).toContain("Missing instructions");
    expect(bareResult.problems.join("\n")).toContain('no "eve" dependency');
  });

  test("skips symlinks the extractor would reject", async () => {
    const root = await makeProject();
    await symlink("/tmp", path.join(root, "escape"));
    const result = await collectProjectFiles(root);
    expect(result.files.some((file) => file.name === "escape")).toBe(false);
  });

  test("judges eve specifiers against the instance window", () => {
    expect(eveSpecifierProblem("0.47.6", WINDOW)).toBeNull();
    expect(eveSpecifierProblem("^0.47.2", WINDOW)).toBeNull();
    expect(eveSpecifierProblem("0.45.x", WINDOW)).toBeNull();
    expect(eveSpecifierProblem("0.46.0", WINDOW)).toContain("outside this instance's supported");
    expect(eveSpecifierProblem("^0.47", WINDOW)).toContain("Unsupported");
    expect(eveSpecifierProblem(">=0.45.0 <0.48.0", WINDOW)).toContain("Unsupported");
    expect(eveSpecifierProblem("catalog:", WINDOW)).toContain("Unsupported");
    expect(eveSpecifierProblem(null, WINDOW)).toContain("Missing");
  });

  test("produces archives the system unzip can extract byte-identically", async () => {
    const root = await makeProject();
    const { files } = await collectProjectFiles(root);
    const archive = createZipArchive(files);
    const workDir = await mkdtemp(path.join(os.tmpdir(), "eveland-zip-check-"));
    const archivePath = path.join(workDir, "source.zip");
    await writeFile(archivePath, archive);
    await execFileAsync("unzip", ["-q", archivePath, "-d", path.join(workDir, "out")]);
    const { stdout } = await execFileAsync("cat", [
      path.join(workDir, "out", "agent", "instructions.md"),
    ]);
    expect(stdout).toBe("Be helpful.");
    const listing = await execFileAsync("unzip", ["-Z1", archivePath]);
    expect(listing.stdout.trim().split("\n").sort()).toEqual([
      ".env.example",
      "agent/instructions.md",
      "package.json",
    ]);
  });
});
