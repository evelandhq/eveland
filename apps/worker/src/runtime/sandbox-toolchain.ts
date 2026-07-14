/**
 * Platform-owned command baseline exposed inside every Eve exec sandbox.
 *
 * Keep this list runtime-neutral: Docker bakes the matching Alpine packages
 * into each deployment image, while the systemd preflight verifies that the
 * host root (which bwrap mounts read-only) already provides the same commands.
 */
export const SANDBOX_TOOLCHAIN_COMMANDS = [
  "bash",
  "node",
  "npm",
  "pnpm",
  "rg",
  "grep",
  "find",
  "git",
  "curl",
  "jq",
  "python",
  "python3",
  "pip",
  "pip3",
  "unzip",
  "zstd",
] as const;

export const SANDBOX_TOOLCHAIN_APK_PACKAGES = [
  "bash",
  "bubblewrap",
  "ca-certificates",
  "curl",
  "findutils",
  "git",
  "grep",
  "jq",
  "py3-pip",
  "python3",
  "ripgrep",
  "socat",
  "unzip",
  "zstd",
] as const;

export const SANDBOX_PNPM_VERSION = "11.7.0";
