import { mkdir } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

export type ImportGitInput = {
  gitUrl: string;
  targetDir: string;
};

export async function importGitSource(input: ImportGitInput): Promise<void> {
  await mkdir(path.dirname(input.targetDir), { recursive: true });
  await execa("git", ["clone", "--depth", "1", input.gitUrl, input.targetDir], {
    all: true,
  });
}

export async function getGitCommitSha(sourceDir: string): Promise<string | null> {
  const result = await execa("git", ["rev-parse", "HEAD"], {
    cwd: sourceDir,
    reject: false,
  });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}
