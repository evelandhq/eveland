export const EVE_COMPATIBILITY_POLICY = {
  supportedLines: [
    {
      range: "1.0.x",
      verifiedVersion: "1.0.0-rc.6",
      dependencyName: "eve",
    },
  ],
  // A single-line window: 0.83 retired on 2026-11-04 (Eveland v0.66.0 had
  // carried 1.0 since 2026-11-02, so every 0.83 Release already had a newer
  // line to rebuild on). Its retirement also retired the v26 session
  // protocol: every line in the window now speaks v27, so the Dashboard
  // bundles one `eve/client`, the injected observer and scheduler read one
  // vocabulary, and the one-way v26 -> v27 session handoff that 0.85 allowed
  // can no longer happen (a retired Release cannot activate, and its parked
  // runs are settled). Sessions and usage that v26 Deployments already
  // recorded stay readable: the Session/usage projection and session replay
  // keep reading the v26 events Postgres holds.
  //
  // 1.0.0-rc.1 (published 2026-10-31; byte-identical to 0.91.0 on every
  // surface Eveland reads) entered on 2026-11-02. 0.84 through 0.91 were
  // skipped: each was superseded within days, and all of them speak the same
  // v27 protocol as 1.0 -- the first line eve puts under semver.
  //
  // 1.0.0-rc.2 (published 2026-11-02) became the verified 1.0 patch on
  // 2026-11-03. Against rc.1 it keeps every pinned surface Eveland reads --
  // discovery manifest 15, compiled agent manifest 55, checkpoint 18, stream
  // 27, the stable workflow names and the bundler default, and every
  // dependency -- and widens two v27 facts: a `call.requested` may be owned by
  // its turn (`owner: { turnId }`) and a `content.completed` may leave out
  // `runId`, with `scope.turnId` naming the turn. rc.2's runtime emits neither
  // yet; the observer, the transcript, and the trace place both under their
  // turn. `eve dev` also resolves a string model through
  // `globalThis.AI_SDK_DEFAULT_PROVIDER` from rc.2 (vercel/eve#5789), as
  // `eve start` already did.
  //
  // 1.0.0-rc.5 (published 2026-11-05) became the verified 1.0 patch the same
  // day; rc.3 and rc.4 were reviewed on the way and never verified. Stream 27
  // and the v27 vocabulary are unchanged: against rc.2, eve's protocol module
  // only adds a checker rule (`cleared-before-start`, on the `clearedBy` that
  // `call.started` already carried) and restructures its fold without
  // changing it, and it is byte-identical from rc.3. What moved: discovery manifest 16 lists every
  // authored source in one `sources` array (an Extension mount's manifest
  // too), which `@evelandhq/core/discovery` and the injected scheduler read
  // beside v15, since the window holds releases built on both; compiled
  // manifest 56 and checkpoint 19; Nitro 3.0.261103-rc (Rolldown 1.2.16, srvx
  // 1.0.8, whose graceful-shutdown plugin keeps 1.0.3's behavior); `eve start`
  // SIGKILLs its server 25 seconds after SIGTERM instead of 20, which the
  // Deployment stop timeout now clears; and the bundled Workflow runtime, core
  // 5.4.0 / world 5.1.0, which `@evelandhq/workflow-world` 0.29.0 pinned
  // first. From rc.3 eve asks for spec 9 (single-orchestrator) runs, which
  // the World serves from 0.30.0 with an in-band writer fence; 0.29.0 kept
  // them on spec 8. Agent-facing only: the code
  // extension drops `code__grep`, `code__worker` (rc.3) and
  // `code__apply_patch` (rc.4), every agent gets a default `edit_file`, and a
  // failed `bash` result ends with `[exit code: N]`.
  //
  // 1.0.0-rc.6 (published 2026-11-05) became the verified 1.0 patch on
  // 2026-11-06. It bundles exactly rc.5's Workflow runtime and keeps every
  // version Eveland pins -- discovery manifest 16, compiled manifest 56,
  // checkpoint 19, stream 27 and the v27 vocabulary -- and only
  // `@vercel/agent-runs` moves (rc.3). What moved for the platform: a session
  // claims its channel address as it starts, with an atomic start Hook
  // (`start({ experimental_hook })`), so racing first messages to one address
  // reach one session and `create()` answers before the session boots; eve
  // refuses to start a session on a World that does not declare
  // `capabilities.atomicStartHook`, which `@evelandhq/workflow-world` 0.31.0
  // implements. A send by session id to a session that is shutting down gets
  // `409 session_not_active` at once instead of `session_not_ready` retries,
  // which the Agent Gateway forwards untouched. Agent-facing only:
  // `agentWithModel` became `agent({ models })`, and an `agent.approval` span
  // now covers every wait on a person, sign-ins included.
  //
  // What the v27 protocol (introduced by 0.84) means for Eveland:
  // - Session events are `{ type, scope?, data }` facts, positioned by
  //   `(line, index)` instead of an event id, with one settled event per item
  //   (`turn.settled`, `session.ended`, `call.settled`, `task.ended`,
  //   `interaction.settled`, `delivery.settled`) whose `outcome` says how it
  //   ended. Provider usage is its own `usage.recorded` fact, owned by a model
  //   run (`owner.runId`).
  // - Hook handlers get `ctx.position` and `ctx.view`, and an unhandled hook
  //   error fails the running turn; the observer's handler never throws.
  // - The stream is version 27, which the 1.0 `eve/client` reads.
  // - Session routes: `POST /session/:id/end` (`/reset` stays as an alias) and
  //   `GET /session/:id/descendants/stream` (followed child sessions), both
  //   pinned by the root session id like `reset` and `stream`. The HTTP
  //   channel rejects unknown top-level body fields with 400, and answers
  //   replace `inputResponses`.
  // - `defineSchedule` takes `content`, and `send()` resolves a `Delivery`
  //   (`sessionId`). `defineChannel` no longer reads `kindHint`, so a
  //   channel's kind is `channel:<name>` (the HTTP channel is `channel:eve`).
  // - The sandbox provider contract names the abort signal `signal` and has
  //   optional spawn `stdin`; `@evelandhq/sandbox-bwrap` reads both.
  // - The bundled Workflow set is core 5.4.0, world 5.1.0 (core 5.2.3, world
  //   5.0.5 on rc.1 and rc.2), spec 9 as the World declares it under rc.3+
  //   (8 on rc.1 and rc.2), which `@evelandhq/workflow-world` 0.30.0 pins and
  //   serves with an in-band writer fence. From 0.76.1 eve treats a World
  //   that does not declare `capabilities.deploymentAffinity` as running one
  //   eve version at a time, and from 0.81.1 a session moves to a fresh run
  //   only when the World declares `capabilities.hookForceClaim`; the shared
  //   World declares both.
  peerDependencyRange: ">=1.0.0-0 <1.1.0",
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
  SUPPORTED_EVE_VERSION_RANGES.length === 1
    ? SUPPORTED_EVE_VERSION_RANGES[0]!
    : SUPPORTED_EVE_VERSION_RANGES.length === 2
      ? `${SUPPORTED_EVE_VERSION_RANGES[0]} or ${SUPPORTED_EVE_VERSION_RANGES[1]}`
      : `${SUPPORTED_EVE_VERSION_RANGES.slice(0, -1).join(", ")}, or ${SUPPORTED_EVE_VERSION_RANGES.at(-1)}`;

export type EveVersionInfo = {
  version: string | null;
  expected: string;
  supportedRanges: readonly SupportedEveVersionRange[];
  supported: boolean;
  sourceRevisionId: string | null;
};

/**
 * The minor line (`0.83`, `1.0`) an Eve dependency specifier pins, or null
 * when the specifier does not pin exactly one line. The grammar is the one the
 * platform has always accepted -- an exact version, a `~` range, a `0.x` caret
 * range (which npm reads like `~`), or an `x`/`*` patch wildcard -- widened to
 * majors above zero and to prerelease tags on an exact patch (`1.0.0-rc.1`).
 * A caret on a major above zero spans every later minor, so it is refused, as
 * is any range that does not name its patch.
 */
export function eveLineOfSpecifier(specifier: string | null): string | null {
  if (specifier === null) return null;
  const match = specifier
    .trim()
    .match(/^([~^]?)(\d+)\.(\d+)(?:\.(\d+|[x*])(?:-([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?)?$/);
  if (!match) return null;
  const [, operator, major, minor, patch, prerelease] = match;
  if (prerelease !== undefined && !/^\d+$/.test(patch ?? "")) return null;
  if (operator && (patch === undefined || patch === "x" || patch === "*")) return null;
  if (operator === "^" && major !== "0") return null;
  return `${Number(major)}.${Number(minor)}`;
}

export function isSupportedEveDependency(specifier: string | null): boolean {
  const line = eveLineOfSpecifier(specifier);
  return (
    line !== null && SUPPORTED_EVE_VERSION_RANGES.includes(`${line}.x` as SupportedEveVersionRange)
  );
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
