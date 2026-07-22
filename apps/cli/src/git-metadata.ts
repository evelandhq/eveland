import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitMetadata = {
  commitSha: string | null;
  branch: string | null;
  dirty: boolean;
};

export async function getGitMetadata(root: string): Promise<GitMetadata | undefined> {
  try {
    await git(root, ["rev-parse", "--is-inside-work-tree"]);
    const [commitSha, branch, status] = await Promise.all([
      git(root, ["rev-parse", "HEAD"]).catch(() => ""),
      git(root, ["branch", "--show-current"]).catch(() => ""),
      git(root, ["status", "--porcelain", "--untracked-files=normal"]),
    ]);
    return {
      commitSha: commitSha || null,
      branch: branch || null,
      dirty: status.length > 0,
    };
  } catch {
    return undefined;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}
