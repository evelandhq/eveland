export const EVE_COMPATIBILITY_POLICY = {
  supportedLines: [
    {
      range: "0.31.x",
      verifiedVersion: "0.31.3",
      dependencyName: "eve-oldest",
    },
    {
      range: "0.32.x",
      verifiedVersion: "0.32.0",
      dependencyName: "eve-middle",
    },
    {
      range: "0.33.x",
      verifiedVersion: "0.33.2",
      dependencyName: "eve",
    },
  ],
  peerDependencyRange: ">=0.31.0 <0.34.0",
} as const;

export type SupportedEveVersionRange =
  (typeof EVE_COMPATIBILITY_POLICY.supportedLines)[number]["range"];

export const SUPPORTED_EVE_VERSION_RANGES = EVE_COMPATIBILITY_POLICY.supportedLines.map(
  ({ range }) => range,
) as readonly SupportedEveVersionRange[];

export const VERIFIED_EVE_VERSIONS = EVE_COMPATIBILITY_POLICY.supportedLines.map(
  ({ verifiedVersion }) => verifiedVersion,
);

export const OLDEST_VERIFIED_EVE_VERSION = VERIFIED_EVE_VERSIONS[0]!;

export const LATEST_VERIFIED_EVE_VERSION = VERIFIED_EVE_VERSIONS[VERIFIED_EVE_VERSIONS.length - 1]!;

export const SUPPORTED_EVE_VERSION_RANGE = `${SUPPORTED_EVE_VERSION_RANGES.slice(0, -1).join(
  ", ",
)}, or ${SUPPORTED_EVE_VERSION_RANGES.at(-1)}`;

export type EveVersionInfo = {
  version: string | null;
  expected: string;
  supportedRanges: readonly SupportedEveVersionRange[];
  supported: boolean;
  sourceRevisionId: string | null;
};

export function isSupportedEveDependency(specifier: string | null): boolean {
  if (specifier === null) return false;
  const match = specifier.trim().match(/^([~^]?)(0\.\d+)(?:\.(\d+|[x*]))?$/);
  if (!match) return false;
  const [, operator, minor, patch] = match;
  if (operator && (patch === undefined || patch === "x" || patch === "*")) {
    return false;
  }
  return SUPPORTED_EVE_VERSION_RANGES.includes(`${minor}.x` as SupportedEveVersionRange);
}

/**
 * The minor line a single-minor Eve dependency specifier names (31 for
 * "~0.31.2"), or null for missing, wildcard, or cross-minor specifiers.
 * Callers that need generation-specific behavior (the Eve 0.30→0.31 session
 * API split) branch on this after the specifier passed
 * {@link isSupportedEveDependency}.
 */
export function eveMinorFromDependency(specifier: string | null): number | null {
  const match = specifier?.trim().match(/^[~^]?0\.(\d+)(?:\.(?:\d+|[x*]))?$/);
  return match?.[1] === undefined ? null : Number(match[1]);
}

export function unsupportedEveVersionMessage(specifier: string | null): string {
  if (specifier === null) {
    return `Missing Eve dependency. Eveland requires Eve ${SUPPORTED_EVE_VERSION_RANGE}. Add the "eve" dependency before importing or deploying.`;
  }
  return `Unsupported Eve dependency "${specifier}". Eveland requires Eve ${SUPPORTED_EVE_VERSION_RANGE}. Upgrade the project's "eve" dependency before importing or deploying.`;
}

export function createEveVersionInfo(
  version: string | null,
  sourceRevisionId: string | null,
): EveVersionInfo {
  return {
    version,
    expected: SUPPORTED_EVE_VERSION_RANGE,
    supportedRanges: [...SUPPORTED_EVE_VERSION_RANGES],
    supported: isSupportedEveDependency(version),
    sourceRevisionId,
  };
}
