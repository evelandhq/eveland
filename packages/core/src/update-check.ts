import type { EvelandReleaseChannel } from "@evelandhq/core/build-info";
import { evelandReleaseChannels } from "@evelandhq/core/build-info";

/**
 * What an installation knows about its own release and the one it could move
 * to. `eveland-ctl` is the only writer: it derives the checkout's identity
 * from git and — for a stable install with the check enabled — asks the same
 * git remote `update` upgrades from for the newest release tag. `eveland-ctl
 * status` and the Dashboard's About page are readers, and neither ever waits
 * on the network: they see whatever the last check left behind.
 *
 * Which is why the only claim this file may support is "a newer release
 * exists". It is stale by design — a machine nobody logs into can carry a
 * month-old check — so nothing here ever concludes "up to date": an answer
 * that goes quiet when it does not know is never wrong, one that asserts
 * currency from a stale file is wrong exactly when it matters.
 */

export type UpdateCheck = {
  /** When the remote was last reached; null when it never was (checks off, or not a stable install). */
  checkedAt: string | null;
  /** The checkout's version and git identity when this file was written. */
  version: string;
  revision: string;
  channel: EvelandReleaseChannel;
  /** The exact tag the checkout sits on, when it sits on one. */
  tag: string | null;
  /** The newest stable tag the remote offered (`vX.Y.Z`); null when unknown. */
  latestTag: string | null;
  /** Versions after `version` up to `latestTag` whose changelog carries BREAKING CHANGES. */
  breaking: string[];
};

export type AvailableUpdate = {
  /** `vX.Y.Z` — what `eveland-ctl update` would move to. */
  tag: string;
  version: string;
  /** Breaking-change versions the move would cross, oldest first. */
  breaking: string[];
};

/** `vX.Y.Z` (with or without the `v`) → [x, y, z]; anything else → null. */
function parseVersion(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isNewer(candidate: [number, number, number], current: [number, number, number]): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (candidate[i] !== current[i]) return candidate[i]! > current[i]!;
  }
  return false;
}

/**
 * Tolerant on purpose: this file is read by processes that must render
 * something useful whatever state the disk is in, so a shape that is not
 * recognisable is "no check", never an exception.
 */
export function parseUpdateCheck(raw: string): UpdateCheck | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Partial<UpdateCheck>;
  if (typeof candidate.version !== "string" || typeof candidate.revision !== "string") return null;
  if (!evelandReleaseChannels.includes(candidate.channel as EvelandReleaseChannel)) return null;
  return {
    checkedAt: typeof candidate.checkedAt === "string" ? candidate.checkedAt : null,
    version: candidate.version,
    revision: candidate.revision,
    channel: candidate.channel as EvelandReleaseChannel,
    tag: typeof candidate.tag === "string" ? candidate.tag : null,
    latestTag: typeof candidate.latestTag === "string" ? candidate.latestTag : null,
    breaking: Array.isArray(candidate.breaking)
      ? candidate.breaking.filter((version): version is string => typeof version === "string")
      : [],
  };
}

/**
 * The update a reader may announce, or null — which covers every "we do not
 * know" case as well as "nothing newer": a missing check, an unparsable
 * version, and a `latestTag` that is not strictly ahead of the checkout.
 */
export function availableUpdate(check: UpdateCheck | null): AvailableUpdate | null {
  if (!check?.latestTag) return null;
  const latest = parseVersion(check.latestTag);
  const current = parseVersion(check.version);
  if (!latest || !current || !isNewer(latest, current)) return null;
  return {
    tag: check.latestTag,
    version: latest.join("."),
    breaking: check.breaking,
  };
}

/**
 * Whether the checkout on disk has moved away from the revision a process was
 * started with — someone pulled without updating, or an update died between
 * moving the tree and restarting the platform. Silent when either side is
 * unknown: `EVELAND_REVISION` is "unknown" in a development checkout.
 */
export function revisionDrift(
  check: UpdateCheck | null,
  runningRevision: string | undefined,
): { checkout: string; running: string } | null {
  const running = runningRevision?.trim();
  if (!check || !running || running === "unknown" || running === check.revision) return null;
  return { checkout: check.revision, running };
}
