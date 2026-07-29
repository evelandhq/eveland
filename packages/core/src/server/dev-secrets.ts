/**
 * A publicly known development fallback secret may substitute for an explicit
 * env value ONLY when NODE_ENV explicitly says development or test. An unset
 * NODE_ENV is treated like production: a deployment that forgot to set it must
 * fail to start, not silently guard privileged surfaces with a secret anyone
 * can read in this repository.
 */
export function resolveSecretWithDevFallback(
  env: NodeJS.ProcessEnv,
  explicitValue: string | undefined,
  developmentFallback: string,
): string | undefined {
  if (explicitValue) return explicitValue;
  return env.NODE_ENV === "development" || env.NODE_ENV === "test"
    ? developmentFallback
    : undefined;
}
