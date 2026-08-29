export const EVE_COMPATIBILITY_POLICY = {
  supportedLines: [
    {
      range: "0.45.x",
      verifiedVersion: "0.45.2",
      dependencyName: "eve-oldest",
    },
    {
      range: "0.47.x",
      verifiedVersion: "0.47.3",
      dependencyName: "eve",
    },
  ],
  // 0.46 is deliberately skipped (like 0.40/0.41 and 0.43 before it): 0.47.0
  // superseded it within hours, and skipping is safe because every wire
  // format is byte-identical across the span -- the one 0.46-introduced
  // change, stream protocol v24, ships identically in 0.47.x. The range is
  // therefore the union of the two contiguous runs, not their hull, which
  // would admit the skipped line.
  peerDependencyRange: ">=0.45.0 <0.46.0 || >=0.47.0 <0.48.0",
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

export const SUPPORTED_EVE_VERSION_RANGE =
  SUPPORTED_EVE_VERSION_RANGES.length === 2
    ? `${SUPPORTED_EVE_VERSION_RANGES[0]} or ${SUPPORTED_EVE_VERSION_RANGES[1]}`
    : `${SUPPORTED_EVE_VERSION_RANGES.slice(0, -1).join(", ")}, or ${SUPPORTED_EVE_VERSION_RANGES.at(-1)}`;

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

export function unsupportedEveVersionMessage(specifier: string | null): string {
  if (specifier === null) {
    return `Missing Eve dependency. Eveland requires Eve ${SUPPORTED_EVE_VERSION_RANGE}. Add the "eve" dependency before importing or deploying.`;
  }
  return `Unsupported Eve dependency "${specifier}". Eveland requires Eve ${SUPPORTED_EVE_VERSION_RANGE}. Upgrade the project's "eve" dependency before importing or deploying.`;
}

/**
 * Recognizes an {@link unsupportedEveVersionMessage} that has crossed a process
 * boundary as plain text -- the worker records it on
 * `runtime_instances.last_error` and the activation route reads it back, so the
 * typed throw is long gone by the time a status code has to be chosen. A
 * version gate cannot pass on a retry, so callers answer with a terminal status
 * rather than a retryable one.
 */
export function isUnsupportedEveVersionMessage(message: string): boolean {
  return /^(?:Unsupported|Missing) Eve dependency\b/.test(message);
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
