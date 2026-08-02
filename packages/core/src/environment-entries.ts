/**
 * The Agent environment-entry rules, in one place.
 *
 * Project secrets, the shared platform environment, and the new-project flow
 * all collect the same key/kind/value entry, and the API validates the same
 * shape again on the way in. The pattern and the normalization used to be
 * spelled out at five sites with three different uniqueness messages, so a
 * policy change (a length cap, allowing lowercase) was a shotgun edit that
 * could leave the client and server disagreeing. Follows the precedent set by
 * the project-slug rules in ./ids.
 *
 * The rule is shared; the wording around it is not. Each surface keeps its
 * own duplicate-key message ("Project environment names...", "Shared
 * environment keys...") because that context is what makes the error
 * actionable.
 */

export const ENVIRONMENT_ENTRY_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export const ENVIRONMENT_ENTRY_KEY_MESSAGE =
  "Use uppercase letters, numbers, and underscores, starting with a letter.";

export type EnvironmentEntryKind = "variable" | "secret";

/** Trim and upper-case a typed key before validating or persisting it. */
export function normalizeEnvironmentEntryKey(value: string): string {
  return value.trim().toUpperCase();
}

export function isValidEnvironmentEntryKey(value: string): boolean {
  return ENVIRONMENT_ENTRY_KEY_PATTERN.test(value);
}

/**
 * First duplicate in a set of normalized keys, or null. `exceptKey` lets an
 * edit dialog keep the entry's own current key.
 */
export function findDuplicateEnvironmentEntryKey(
  keys: readonly string[],
  exceptKey?: string,
): string | null {
  const seen = new Set<string>();
  for (const key of keys) {
    if (exceptKey !== undefined && key === exceptKey) continue;
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return null;
}
