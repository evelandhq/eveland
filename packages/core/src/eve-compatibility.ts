import { intersects, satisfies, validRange } from "semver";

/**
 * The Eve versions Eveland hosts: every release from 1.0.0 through the newest
 * verified minor. The floor stays at 1.0.0 for the whole 1.x line, so a
 * Release that was inside the window when it was built stays inside it;
 * verifying a newer minor only raises the ceiling.
 *
 * The surfaces Eveland reads from eve -- session stream 27, discovery manifest
 * 16, the Workflow World capabilities and spec range, the stable workflow
 * names -- are asserted against the installed `eve` by the architecture
 * ratchets, so raising the ceiling is a reviewed change that reruns them.
 */
export const SUPPORTED_EVE_RANGE = ">=1.0.0 <1.4.0";

/** The newest eve release the compatibility suites ran against. */
export const VERIFIED_EVE_VERSION = "1.3.0";

/** What the platform reports about one project's or Deployment's Eve. */
export type EveVersionInfo = {
  /** The build-resolved version, or the declared specifier before any build. */
  version: string | null;
  sourceRevisionId: string | null;
};

/**
 * Whether a declared `eve` specifier can resolve inside the window: any npm
 * range that intersects it (`^1.0.0`, `~1.0.2`, `1.0.0`, `1.x`) passes. This
 * is only the early, pre-install check; the build gates on the version it
 * actually installed ({@link isSupportedEveVersion}).
 */
export function isSupportedEveSpecifier(specifier: string | null): boolean {
  if (specifier === null || specifier.trim() === "") return false;
  const range = validRange(specifier.trim());
  return range !== null && intersects(range, SUPPORTED_EVE_RANGE);
}

/** Whether an installed eve version (an exact version, never a range) is hosted. */
export function isSupportedEveVersion(version: string | null): boolean {
  return version !== null && satisfies(version, SUPPORTED_EVE_RANGE);
}

export function unsupportedEveSpecifierMessage(specifier: string | null): string {
  if (specifier === null) {
    return `Missing Eve dependency. Eveland hosts eve ${SUPPORTED_EVE_RANGE}. Add an "eve" dependency such as "^${VERIFIED_EVE_VERSION}" before importing or deploying.`;
  }
  return `Unsupported Eve dependency "${specifier}". Eveland hosts eve ${SUPPORTED_EVE_RANGE}, and this range cannot resolve inside it. Declare a range such as "^${VERIFIED_EVE_VERSION}".`;
}

export function unsupportedEveVersionMessage(version: string | null): string {
  if (version === null) {
    return `The build did not install eve, so its version could not be checked against ${SUPPORTED_EVE_RANGE}.`;
  }
  return `The build installed eve ${version}, outside the versions Eveland hosts (${SUPPORTED_EVE_RANGE}). Pin "eve" to a version inside that range (for example "~${VERIFIED_EVE_VERSION}") or update the lockfile, then redeploy.`;
}
