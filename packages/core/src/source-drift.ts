import type { ProjectImportKind, ReleaseSourceProvenance, SourceDrift } from "./contracts.js";

/**
 * Production has drifted when a git Project's promoted Release came from an
 * upload: the next repository sync would replace a hotfix nobody committed.
 * Derived, so it needs no bookkeeping to clear: promoting a synced commit
 * (or having no production at all) is not drift.
 */
export function deriveSourceDrift(
  importKind: ProjectImportKind,
  production: ReleaseSourceProvenance | null,
): SourceDrift {
  if (importKind === "git" && production && production.kind !== "git") {
    return { drifted: true, production };
  }
  return { drifted: false, production };
}
