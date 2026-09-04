import type { ExecCommand } from "./io.ts";

/**
 * Release identity of a checkout, pinned into etc/eveland.env at first boot
 * and refreshed by update. The channel follows the upgrade contract
 * (docs/operations/upgrades): `stable` means an exact vX.Y.Z tag — a bare
 * SHA, a branch, or a pre-release tag must never impersonate a stable
 * release. The revision is always the exact 12-character short SHA the
 * upgrade contract documents (`git rev-parse --short=12 HEAD`).
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

/** `vX.Y.Z` → [X, Y, Z]; anything else (a SHA, a branch, a pre-release) → null. */
export function parseReleaseTag(tag: string): [number, number, number] | null {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * The newest exact vX.Y.Z tag in `git tag --list "v*" --sort=-v:refname`
 * output: a pre-release sorts above the stable it precedes and is never a
 * default target. This is what "the latest release" MEANS on this machine —
 * `update` moves here, and `status` reports from here, so the two cannot
 * disagree about whether an installation is current.
 */
export function newestStableTag(tagListOutput: string): string | undefined {
  return tagListOutput
    .split("\n")
    .map((line) => line.trim())
    .find((tag) => parseReleaseTag(tag) !== null);
}

export function channelForTag(tag: string | null): ReleaseChannel {
  if (tag && STABLE_TAG.test(tag)) return "stable";
  if (tag && PRERELEASE_TAG.test(tag)) return "prerelease";
  return "edge";
}

export async function deriveReleaseIdentity(
  execCommand: ExecCommand,
  cwd: string,
): Promise<ReleaseIdentity | null> {
  const sha = await execCommand(["git", "rev-parse", "--short=12", "HEAD"], { cwd });
  if (sha.code !== 0 || sha.output.trim() === "") return null;
  const exact = await execCommand(["git", "describe", "--tags", "--exact-match"], { cwd });
  const tag = exact.code === 0 ? (exact.output.trim().split("\n")[0] ?? null) : null;
  return {
    channel: channelForTag(tag),
    revision: sha.output.trim().split("\n")[0]!,
    tag,
  };
}
