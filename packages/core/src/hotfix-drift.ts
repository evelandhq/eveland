import type { HotfixDrift } from "./contracts.js";

/**
 * One wording for hotfix drift, shared by the API's refusal, the worker's
 * deploy log, the CLI and the Dashboard, so an operator reads the same
 * sentence wherever the drift surfaces.
 */

/** "2026-09-07 14:02 UTC": unambiguous where no viewer time zone exists. */
export function formatUtcMinute(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * The facts that identify the hotfix, in reading order and without the time
 * (which each surface formats for its own viewer): what it was based on,
 * whether the tree was clean, who uploaded it.
 */
export function hotfixDriftFacts(drift: HotfixDrift): string[] {
  const { source } = drift;
  const facts: string[] = [];
  if (source.baseCommitSha) facts.push(`based on ${source.baseCommitSha.slice(0, 12)}`);
  else facts.push("not based on any known commit");
  if (source.dirty === true) facts.push("uncommitted changes");
  else if (source.dirty === false) facts.push("clean tree");
  if (source.uploadedBy) facts.push(`by ${source.uploadedBy.name || source.uploadedBy.email}`);
  return facts;
}

/** "an uploaded hotfix (based on abc123def456, uncommitted changes, by michael at 2026-09-07 14:02 UTC)" */
export function describeHotfixDrift(
  drift: HotfixDrift,
  options: { formatTime?: (iso: string) => string } = {},
): string {
  const at = (options.formatTime ?? formatUtcMinute)(drift.source.recordedAt);
  return `an uploaded hotfix (${hotfixDriftFacts(drift).join(", ")} at ${at})`;
}

/** The warning every surface prints while a git project is in drift. */
export function hotfixDriftWarning(
  drift: HotfixDrift,
  options: { formatTime?: (iso: string) => string } = {},
): string {
  return `Production runs ${describeHotfixDrift(drift, options)}; the repository does not contain it. Commit it before the next production sync.`;
}
