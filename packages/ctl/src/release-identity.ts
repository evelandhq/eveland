import type { ExecCommand } from "./io.ts";

/**
 * Release identity of a checkout, pinned into etc/eveland.env at first boot
 * and refreshed by update. The channel follows the upgrade contract
 * (docs/operations/upgrades): `stable` means an exact vX.Y.Z tag — a bare
 * SHA, a branch, or a pre-release tag must never impersonate a stable
 * release. The revision is always the exact short SHA.
 */

export type ReleaseChannel = "stable" | "prerelease" | "edge";

export type ReleaseIdentity = {
  channel: ReleaseChannel;
  revision: string;
  /** The exact tag when the checkout sits on one. */
  tag: string | null;
};

const STABLE_TAG = /^v\d+\.\d+\.\d+$/;
const PRERELEASE_TAG = /^v\d+\.\d+\.\d+-/;

export function channelForTag(tag: string | null): ReleaseChannel {
  if (tag && STABLE_TAG.test(tag)) return "stable";
  if (tag && PRERELEASE_TAG.test(tag)) return "prerelease";
  return "edge";
}

export async function deriveReleaseIdentity(
  execCommand: ExecCommand,
  cwd: string,
): Promise<ReleaseIdentity | null> {
  const sha = await execCommand(["git", "rev-parse", "--short", "HEAD"], { cwd });
  if (sha.code !== 0 || sha.output.trim() === "") return null;
  const exact = await execCommand(["git", "describe", "--tags", "--exact-match"], { cwd });
  const tag = exact.code === 0 ? (exact.output.trim().split("\n")[0] ?? null) : null;
  return {
    channel: channelForTag(tag),
    revision: sha.output.trim().split("\n")[0]!,
    tag,
  };
}
