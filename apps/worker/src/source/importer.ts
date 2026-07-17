import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

export type ImportGitInput = {
  gitUrl: string;
  targetDir: string;
  timeoutMs?: number;
};

export async function importGitSource(input: ImportGitInput): Promise<void> {
  await mkdir(path.dirname(input.targetDir), { recursive: true });
  const timeoutMs = input.timeoutMs ?? Number(process.env.EVELAND_GIT_CLONE_TIMEOUT_MS ?? 120_000);
  try {
    await execa("git", ["clone", "--depth", "1", input.gitUrl, input.targetDir], {
      all: true,
      env: { GIT_TERMINAL_PROMPT: "0" },
      timeout: timeoutMs,
    });
  } catch (error) {
    await rm(input.targetDir, { recursive: true, force: true });
    if (isTimedOutError(error)) {
      throw new Error(
        `Repository fetch timed out after ${timeoutMs}ms. Check the worker network, proxy, DNS, or repository availability, then retry.`,
        { cause: error },
      );
    }
    const detail = gitErrorOutput(error);
    throw new Error(detail ? `Repository fetch failed: ${detail}` : "Repository fetch failed. Check the repository URL, credentials, and worker network, then retry.", {
      cause: error,
    });
  }
}

export async function getGitCommitSha(sourceDir: string): Promise<string | null> {
  const result = await execa("git", ["rev-parse", "HEAD"], {
    cwd: sourceDir,
    reject: false,
  });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

function isTimedOutError(error: unknown): error is { timedOut: true } {
  return typeof error === "object" && error !== null && "timedOut" in error && error.timedOut === true;
}

function gitErrorOutput(error: unknown): string {
  if (typeof error !== "object" || error === null || !("stderr" in error) || typeof error.stderr !== "string") return "";
  return error.stderr.trim().slice(0, 2_000).replace(/\b(https?:\/\/)[^/@\s]+@/gi, "$1***@");
}
