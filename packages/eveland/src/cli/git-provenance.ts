import { execFile } from "node:child_process";

/**
 * What `eveland deploy` can say about the directory it uploads: the commit
 * the working tree is based on and whether anything is uncommitted. Absent
 * when the directory is not inside a git work tree, git is not installed, or
 * the repository has no commits yet -- an upload from such a directory is
 * still fine, it just records no base.
 */
export type GitProvenance = {
  baseCommitSha: string;
  dirty: boolean;
};

export type CommandRunner = (file: string, args: string[], cwd: string) => Promise<string>;

const GIT_TIMEOUT_MS = 10_000;
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const runCommand: CommandRunner = (file, args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });

export async function detectGitProvenance(
  dir: string,
  run: CommandRunner = runCommand,
): Promise<GitProvenance | null> {
  try {
    const head = (await run("git", ["rev-parse", "HEAD"], dir)).trim();
    if (!COMMIT_SHA.test(head)) return null;
    // Untracked files count: they are in the upload and not in the commit.
    const status = await run("git", ["status", "--porcelain"], dir);
    return { baseCommitSha: head, dirty: status.trim().length > 0 };
  } catch {
    return null;
  }
}

export function describeGitProvenance(provenance: GitProvenance | null): string {
  if (!provenance) return "Source: not a git checkout, so no base commit will be recorded.";
  return `Source: based on commit ${provenance.baseCommitSha.slice(0, 12)} (${
    provenance.dirty ? "with uncommitted changes" : "clean"
  }).`;
}
