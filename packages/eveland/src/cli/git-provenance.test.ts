import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { describeGitProvenance, detectGitProvenance } from "./git-provenance.ts";

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run("git", args, { cwd });

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "eveland-provenance-"));
  await git(dir, "init", "--initial-branch=main");
  await git(dir, "config", "user.email", "cli@example.test");
  await git(dir, "config", "user.name", "CLI Test");
  await writeFile(path.join(dir, "package.json"), "{}");
  await git(dir, "add", ".");
  await git(dir, "commit", "-m", "fixture");
  return dir;
}

describe("detectGitProvenance", () => {
  test("reports the checked-out commit and whether the tree is clean", async () => {
    const dir = await makeRepo();
    const head = (await git(dir, "rev-parse", "HEAD")).stdout.trim();

    await expect(detectGitProvenance(dir)).resolves.toEqual({ baseCommitSha: head, dirty: false });

    // Untracked files are part of the upload, so they count as dirty.
    await writeFile(path.join(dir, "notes.md"), "wip");
    await expect(detectGitProvenance(dir)).resolves.toEqual({ baseCommitSha: head, dirty: true });

    // A subdirectory of the work tree is still the same checkout.
    await expect(detectGitProvenance(path.join(dir, "."))).resolves.toMatchObject({
      baseCommitSha: head,
    });
  });

  test("reports nothing outside a checkout, before the first commit, or without git", async () => {
    const plain = await mkdtemp(path.join(os.tmpdir(), "eveland-plain-"));
    await expect(detectGitProvenance(plain)).resolves.toBeNull();

    const empty = await mkdtemp(path.join(os.tmpdir(), "eveland-empty-repo-"));
    await git(empty, "init", "--initial-branch=main");
    await expect(detectGitProvenance(empty)).resolves.toBeNull();

    const missingGit = async () => {
      throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    };
    await expect(detectGitProvenance(plain, missingGit)).resolves.toBeNull();

    // A runner that answers something that is not a commit is not trusted.
    await expect(
      detectGitProvenance(plain, async () => "fatal: not a git repository\n"),
    ).resolves.toBeNull();
  });

  test("describes what it found in one line", () => {
    expect(describeGitProvenance(null)).toBe(
      "Source: not a git checkout, so no base commit will be recorded.",
    );
    expect(describeGitProvenance({ baseCommitSha: "a".repeat(40), dirty: false })).toBe(
      "Source: based on commit aaaaaaaaaaaa (clean).",
    );
    expect(describeGitProvenance({ baseCommitSha: "b".repeat(40), dirty: true })).toBe(
      "Source: based on commit bbbbbbbbbbbb (with uncommitted changes).",
    );
  });
});
