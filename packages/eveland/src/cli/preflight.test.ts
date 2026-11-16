import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  collectProjectFiles,
  eveSpecifierProblem,
  SOURCE_PROJECTION_FILE_BYTES,
} from "./preflight.ts";
import { createZipArchive } from "./zip.ts";

const execFileAsync = promisify(execFile);
// The range an instance reports as `eve.supportedRange`.
const WINDOW = ">=1.0.0 <1.1.0";

async function makeProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "eveland-preflight-"));
  await mkdir(path.join(root, "agent"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "junk"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "probe", dependencies: { eve: "0.83.3" } }),
  );
  await writeFile(path.join(root, "agent", "instructions.md"), "Be helpful.");
  await writeFile(path.join(root, "node_modules", "junk", "big.js"), "excluded");
  await writeFile(path.join(root, ".env.example"), "MY_KEY=");
  return root;
}

describe("deploy preflight", () => {
  test("packs the tree faithfully: dotfiles, build output, and binaries all ship", async () => {
    const root = await makeProject();
    // The server's source-browser scanner ignores these for its projection,
    // but the Release builds from the full uploaded tree — dropping them
    // would deploy different code than the local directory runs.
    await writeFile(path.join(root, ".npmrc"), "registry=https://registry.npmjs.org/");
    await mkdir(path.join(root, "src", "build"), { recursive: true });
    await writeFile(path.join(root, "src", "build", "generated.ts"), "export const x = 1;");
    await writeFile(path.join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x47]));

    const result = await collectProjectFiles(root);

    expect(result.files.map((file) => file.name)).toEqual([
      ".env.example",
      ".npmrc",
      "agent/instructions.md",
      "logo.png",
      "package.json",
      "src/build/generated.ts",
    ]);
    expect(result.problems).toEqual([]);
    // Projection-only effects warn instead of refusing.
    expect(result.warnings.join("\n")).toContain("logo.png is binary");
    expect(result.eveSpecifier).toBe("0.83.3");
    expect(result.projectName).toBe("probe");
  });

  test("warns on oversized projection files", async () => {
    const root = await makeProject();
    await writeFile(
      path.join(root, "agent", "big.md"),
      "x".repeat(SOURCE_PROJECTION_FILE_BYTES + 1),
    );
    const result = await collectProjectFiles(root);
    expect(result.problems).toEqual([]);
    expect(result.warnings.join("\n")).toContain("agent/big.md");
  });

  test("fails closed on value-bearing .env files at any depth — no override", async () => {
    const root = await makeProject();
    await writeFile(path.join(root, ".env"), "SECRET=real-value");
    await mkdir(path.join(root, "agent", "config"), { recursive: true });
    await writeFile(path.join(root, "agent", "config", ".env.local"), "NESTED=value");
    const result = await collectProjectFiles(root);
    const problems = result.problems.join("\n");
    expect(problems).toContain(".env would put its values into the source record");
    expect(problems).toContain("agent/config/.env.local");
    expect(problems).toContain("eveland env set");
    // Value-free conventions stay allowed.
    expect(problems).not.toContain(".env.example");
  });

  test("fails closed on credential-bearing .npmrc, allows plain registry config", async () => {
    const root = await makeProject();
    await writeFile(
      path.join(root, ".npmrc"),
      "registry=https://registry.example.com/\n//registry.example.com/:_authToken=npm_secret\n",
    );
    const withToken = await collectProjectFiles(root);
    expect(withToken.problems.join("\n")).toContain(".npmrc carries registry credentials");

    await writeFile(path.join(root, ".npmrc"), "registry=https://registry.example.com/\n");
    const plain = await collectProjectFiles(root);
    expect(plain.problems).toEqual([]);
    expect(plain.files.some((file) => file.name === ".npmrc")).toBe(true);
  });

  test("reads the eve dependency from devDependencies too, like the server", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eveland-devdep-"));
    await mkdir(path.join(root, "agent"), { recursive: true });
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "dev-probe", devDependencies: { eve: "0.83.3" } }),
    );
    await writeFile(path.join(root, "agent", "instructions.md"), "Hi.");
    const result = await collectProjectFiles(root);
    expect(result.eveSpecifier).toBe("0.83.3");
    expect(result.problems).toEqual([]);
  });

  test("flags the genuinely fatal problems", async () => {
    const bare = await mkdtemp(path.join(os.tmpdir(), "eveland-bare-"));
    await writeFile(path.join(bare, "package.json"), JSON.stringify({ dependencies: {} }));
    const result = await collectProjectFiles(bare);
    expect(result.problems.join("\n")).toContain("Missing agent/instructions");
    expect(result.problems.join("\n")).toContain('no "eve" dependency');
  });

  // The server refuses eve's flat layout; the CLI says so before uploading.
  test("flags agent files at the project root", async () => {
    const flat = await mkdtemp(path.join(os.tmpdir(), "eveland-flat-"));
    await writeFile(
      path.join(flat, "package.json"),
      JSON.stringify({ dependencies: { eve: "^1" } }),
    );
    await writeFile(path.join(flat, "instructions.md"), "Hi.");
    const result = await collectProjectFiles(flat);
    expect(result.problems).toEqual([
      expect.stringContaining("Eveland deploys one agent per repository, with its files in agent/"),
    ]);
    expect(result.problems[0]).toContain("flat layout");
  });

  test("skips symlinks the extractor would reject", async () => {
    const root = await makeProject();
    await symlink("/tmp", path.join(root, "escape"));
    const result = await collectProjectFiles(root);
    expect(result.files.some((file) => file.name === "escape")).toBe(false);
  });

  test("judges eve specifiers against the range the instance hosts", () => {
    // Anything that can resolve inside the range passes, including the caret
    // range `eve init` writes; the build gates on what it actually installs.
    for (const specifier of ["^1.0.0", "^1", "~1.0.0", "1.0.0", "1.0.x", "1.x", "*"]) {
      expect(eveSpecifierProblem(specifier, WINDOW), specifier).toBeNull();
    }
    for (const specifier of ["0.83.3", "^0.83.0", "1.0.0-rc.2", "1.1.0", "2.0.0"]) {
      expect(eveSpecifierProblem(specifier, WINDOW), specifier).toContain("cannot resolve");
    }
    expect(eveSpecifierProblem("catalog:", WINDOW)).toContain("Unsupported");
    expect(eveSpecifierProblem("latest", WINDOW)).toContain("Unsupported");
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
