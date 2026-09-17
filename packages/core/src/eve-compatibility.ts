export const EVE_COMPATIBILITY_POLICY = {
  supportedLines: [
    {
      range: "0.55.x",
      verifiedVersion: "0.55.0",
      dependencyName: "eve-previous",
    },
    {
      range: "0.58.x",
      verifiedVersion: "0.58.1",
      dependencyName: "eve",
    },
  ],
  // A gapped two-line window: 0.58.0 (published 2026-09-17) entered on
  // 2026-09-17 and 0.56/0.57 are skipped. 0.56 was admitted on main for one
  // day and 0.57 for a few hours, and no Eveland release ever carried either,
  // so no Deployment ran on them; 0.58 ships the execution model 0.57
  // introduced (turns run inside the session's own workflow run) with every
  // wire surface byte-identical to 0.57. 0.55 stays as the floor, still
  // verified at 0.55.0. The newest line is verified at 0.58.1, published 53
  // minutes after 0.58.0 and already what `^0.58.0` resolves to: it restamps
  // the version-stamped workflow ids and fixes autoModel under `eve dev`, with
  // dependencies, peers, exports and bundled versions identical to 0.58.0. The
  // range is the union of the two contiguous runs,
  // never the hull, which would admit the skipped lines.
  peerDependencyRange: ">=0.55.0 <0.56.0 || >=0.58.0 <0.59.0",
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

/**
 * Answers with the terminal refusal for a Release whose build installed an Eve
 * version the supported window has since slid past, or null when the Release
 * is startable as far as this gate can tell. Only the build-recorded
 * `eveVersionResolved` is consulted: it names what the image actually
 * contains, so no retry can change the outcome. Declared specifiers (revision
 * summary, package.json) are deliberately ignored here -- they describe the
 * source, not the Release, and the launch path re-reads them itself -- so a
 * Release that predates the recording passes through to that deeper gate.
 */
export function unsupportedReleaseEveVersionMessage(
  releaseSummary: Record<string, unknown> | null,
): string | null {
  const resolved =
    releaseSummary && typeof releaseSummary.eveVersionResolved === "string"
      ? releaseSummary.eveVersionResolved
      : null;
  if (resolved === null || isSupportedEveDependency(resolved)) return null;
  return unsupportedEveVersionMessage(resolved);
}

/**
 * The Eve-version refusal worth *showing* for a Deployment, or null. Same gate
 * as `unsupportedReleaseEveVersionMessage`, minus the Deployments that can
 * never activate again for a reason that has nothing to do with Eve:
 * `permanentDeploymentActivationRefusal` refuses an archived or archiving
 * Deployment on its status before it ever reads the version, so telling
 * someone to upgrade one is noise about work nobody can do.
 */
export function displayedDeploymentEveRefusal(
  deploymentStatus: string,
  releaseSummary: Record<string, unknown> | null,
): string | null {
  if (deploymentStatus === "archived" || deploymentStatus === "archiving") return null;
  return unsupportedReleaseEveVersionMessage(releaseSummary);
}

/**
 * The refusal that no retry, restart, or waiting can clear — the predicate
 * behind settling a Deployment's orphaned workflow runs (issue #433) and
 * filtering them out of dispatcher boot recovery. Deliberately narrower than
 * the activation route's 409 set: a `failed` Deployment is recoverable (the
 * next session activation restarts it), so it does NOT refuse here — only a
 * missing or archiving/archived Deployment, or a Release whose baked Eve
 * version the supported window has slid past, is permanent.
 */
export function permanentDeploymentActivationRefusal(
  deployment: { id: string; status: string } | null | undefined,
  releaseSummary: Record<string, unknown> | null | undefined,
): string | null {
  if (!deployment) return "Deployment no longer exists.";
  if (deployment.status === "archiving" || deployment.status === "archived") {
    return `Deployment ${deployment.id} is ${deployment.status} and can never activate again.`;
  }
  return unsupportedReleaseEveVersionMessage(releaseSummary ?? null);
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
