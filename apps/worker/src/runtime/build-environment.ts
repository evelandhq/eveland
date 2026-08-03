/**
 * Which Agent environment entries a Release build may see.
 *
 * `eve build` imports the project's own agent config to compile the manifest,
 * so whatever that config reads from `process.env` at module load -- typically
 * the model id -- is frozen into the Release. A build that cannot see the entry
 * compiles the authored fallback instead, and that stale value is what every
 * turn of that Release then reports.
 *
 * Only `kind: "variable"` entries qualify: install and build lifecycle scripts
 * are untrusted project code running with the build process's own environment,
 * readable through `/proc/self/environ` regardless of which user runs them, so
 * a `secret` must never reach this boundary.
 */

/**
 * Platform-owned build names a project entry may not take over.
 * `NPM_CONFIG_CACHE` is here because npm reads it case-insensitively alongside
 * `npm_config_cache`, so an entry using it could redirect the shared cache.
 */
export const PLATFORM_BUILD_ENVIRONMENT_KEYS: readonly string[] = [
  "HOME",
  "NPM_CONFIG_CACHE",
  "PATH",
];

export type SelectedBuildVariables = {
  variables: Record<string, string>;
  rejectedKeys: string[];
};

export function selectBuildVariables(
  variables: Readonly<Record<string, string>> | undefined,
): SelectedBuildVariables {
  const reserved = new Set(PLATFORM_BUILD_ENVIRONMENT_KEYS);
  const selected: Record<string, string> = {};
  const rejectedKeys: string[] = [];

  for (const [key, value] of Object.entries(variables ?? {})) {
    if (reserved.has(key)) {
      rejectedKeys.push(key);
      continue;
    }
    selected[key] = value;
  }

  return { variables: selected, rejectedKeys: rejectedKeys.sort() };
}

export function rejectedBuildVariablesLog(rejectedKeys: readonly string[]): string | undefined {
  if (rejectedKeys.length === 0) return undefined;
  return (
    `WARNING: ignored Agent environment variable(s) reserved by the build: ${rejectedKeys.join(", ")}. ` +
    "They still reach the deployed process; only the build keeps the platform's own value."
  );
}
