import { WORKSPACE_ROOT } from "./paths.js";

/** PATH the sandbox sees; the host rootfs is visible read-only, so the standard dirs apply. */
export const DEFAULT_SANDBOX_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export interface BwrapExecInput {
  readonly bwrapPath: string;
  readonly workspaceDir: string;
  /** Host paths mounted over with an empty tmpfs. Caller filters to existing paths. */
  readonly hidePaths: readonly string[];
  readonly shareNetwork: boolean;
  /** Final merged environment; with --clearenv the sandbox sees exactly these variables. */
  readonly env: Readonly<Record<string, string>>;
  /** Sandbox-visible working directory (already /workspace-anchored). */
  readonly chdir: string;
  readonly command: string;
}

export function buildBwrapExecArgs(input: BwrapExecInput): string[] {
  const args = [
    input.bwrapPath,
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
  ];
  // Hide paths BEFORE re-binding the workspace: bind sources resolve against
  // the host filesystem, so a later bind punches through an earlier tmpfs.
  for (const path of input.hidePaths) {
    args.push("--tmpfs", path);
  }
  args.push("--bind", input.workspaceDir, WORKSPACE_ROOT);
  if (!input.shareNetwork) {
    args.push("--unshare-net");
  }
  args.push("--unshare-pid", "--unshare-ipc", "--unshare-uts", "--die-with-parent", "--clearenv");
  for (const [key, value] of Object.entries(input.env)) {
    args.push("--setenv", key, value);
  }
  args.push("--chdir", input.chdir, "bash", "-lc", input.command);
  return args;
}
