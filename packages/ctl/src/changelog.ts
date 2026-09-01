/**
 * release-please CHANGELOG.md parsing for `eveland-ctl update`: before an
 * upgrade moves the checkout, the operator sees every breaking-change block
 * between the running version and the target and must acknowledge it.
 */

export type ReleaseSection = {
  version: string;
  body: string;
};

/** All release sections, newest first, as release-please writes them. */
export function parseReleaseSections(changelog: string): ReleaseSection[] {
  const sections: ReleaseSection[] = [];
  const headingPattern = /^## \[?(\d+\.\d+\.\d+)\]?.*$/gm;
  const matches = [...changelog.matchAll(headingPattern)];
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]!;
    const start = match.index + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index : changelog.length;
    sections.push({ version: match[1]!, body: changelog.slice(start, end).trim() });
  }
  return sections;
}

export function extractBreakingChanges(sectionBody: string): string | null {
  const match = /###\s*⚠?\s*BREAKING CHANGES\s*\n([\s\S]*?)(?=\n###\s|$)/.exec(sectionBody);
  if (!match) return null;
  const block = match[1]!.trim();
  return block.length > 0 ? block : null;
}

function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The breaking-change blocks an upgrade from `currentVersion` (exclusive) to
 * `targetVersion` (inclusive) crosses, oldest first — an upgrade over several
 * releases must surface every break on the way, not just the target's.
 */
export function breakingChangesBetween(
  changelog: string,
  currentVersion: string,
  targetVersion: string,
): Array<{ version: string; changes: string }> {
  return parseReleaseSections(changelog)
    .filter(
      (section) =>
        compareVersions(section.version, currentVersion) > 0 &&
        compareVersions(section.version, targetVersion) <= 0,
    )
    .map((section) => ({ version: section.version, changes: extractBreakingChanges(section.body) }))
    .filter((entry): entry is { version: string; changes: string } => entry.changes !== null)
    .reverse();
}
