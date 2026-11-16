import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { readSource, repoRoot } from "./scan-support.js";

/**
 * The compatibility surface between `@evelandhq/workflow-world` and the eve
 * releases the platform hosts.
 *
 * These assertions exist because eve enforces the contract in two places that
 * both move independently of us:
 *
 *   1. `validateWorkflowWorld` compares the world package's declared
 *      `@workflow/*` dependency line against the one eve bundles;
 *   2. the runtime rejects any world whose `specVersion` is not the exact
 *      number compiled into that eve release — a literal, baked per release.
 *
 * Neither is a type error, so without this suite an eve bump would fail at
 * deploy time on a real project instead of in CI. The world is resolved from
 * `apps/worker` — the workspace that actually installs the versions the worker
 * injects — and eve from `packages/agent-observer`, which installs the
 * verified release for its own compatibility tests.
 */
const require = createRequire(import.meta.url);

/**
 * Anchored at the workspace that actually declares each dependency. pnpm does
 * not hoist to the repo root, and resolving from there would silently walk up
 * out of the worktree into the parent checkout's node_modules.
 */
const RESOLUTION_ANCHORS: Record<string, string> = {
  "@evelandhq/workflow-world": "apps/worker",
  eve: "packages/agent-observer",
};

function resolveInstalled(specifier: string): string {
  const packageName = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0]!;
  const anchor = RESOLUTION_ANCHORS[packageName];
  if (!anchor) throw new Error(`no resolution anchor registered for ${packageName}`);
  return require.resolve(specifier, { paths: [path.join(repoRoot, anchor)] });
}

/**
 * A package's `exports` map rarely exposes `./package.json`, so the manifest
 * is found by resolving the entry point and walking up to the directory that
 * declares the expected name.
 */
function resolveInstalledPackageRoot(packageName: string, expectedName = packageName): string {
  let directory = path.dirname(resolveInstalled(packageName));
  for (;;) {
    const manifest = path.join(directory, "package.json");
    try {
      if ((readJson(manifest) as { name?: string }).name === expectedName) return directory;
    } catch {
      // keep walking
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`could not find ${packageName}'s package root`);
    directory = parent;
  }
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

/** eve compares only the major and the prerelease tag, not exact versions. */
function versionLine(version: string): { major: string; tag: string | undefined } {
  const [core, prerelease] = version.replace(/^[~^]/, "").split("-", 2);
  return { major: core!.split(".")[0]!, tag: prerelease?.split(".")[0] };
}

// eve's `isDefiniteLineMismatch`: a stable declaration on either side matches
// any prerelease of the same major, so one World serves an eve line bundling
// the @workflow betas and a line bundling the stable release.
function isDefiniteLineMismatch(
  world: ReturnType<typeof versionLine>,
  eve: ReturnType<typeof versionLine>,
): boolean {
  return (
    world.major !== eve.major ||
    (world.tag !== undefined && eve.tag !== undefined && world.tag !== eve.tag)
  );
}

function walkJsFiles(root: string): string[] {
  const collected: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) collected.push(...walkJsFiles(absolute));
    else if (entry.name.endsWith(".js")) collected.push(absolute);
  }
  return collected;
}

/**
 * eve compiles its World spec-version gate per release rather than comparing
 * against an imported constant, so the accepted range is read back out of the
 * shipped bundle. Two forms exist: through 0.32 the gate pins a single version
 * (`specVersion !== 5`), and from 0.33 it accepts a range (`>= 5 && <= 6`)
 * because world-vercel opts into a spec above the default and an equality
 * check would make the runtime refuse the adapter shipped alongside it.
 *
 * The thrown message is parsed rather than the comparison itself: the message
 * is authored text that names both bounds, while the operator sequence is
 * minifier output that already changed shape once.
 */
function findEnforcedSpecVersions(eveDistDir: string): { min: number; max: number } | undefined {
  for (const file of walkJsFiles(eveDistDir)) {
    const source = readFileSync(file, "utf8");
    const range = /spec version (\d+) through (\d+)/.exec(source);
    if (range) return { min: Number(range[1]), max: Number(range[2]) };
    const exact = /matching spec version (\d+)/.exec(source);
    if (exact) return { min: Number(exact[1]), max: Number(exact[1]) };
  }
  return undefined;
}

const worldRoot = resolveInstalledPackageRoot("@evelandhq/workflow-world");
const worldManifest = readJson(path.join(worldRoot, "package.json")) as {
  version: string;
  dependencies: Record<string, string>;
};

/**
 * The spec version the shared World actually DECLARES, read out of its own
 * dist rather than assumed to be the package's current one: eve gates on the
 * declared number, so every range check below has to use this one.
 *
 * The wiring is verified in the dist -- one `worldSpecVersion()` call bound to
 * the `specVersion` the World object carries, which returns the single
 * orchestrator generation -- and the value comes from the `@workflow/world`
 * the World itself resolves.
 */
function declaredWorldSpecVersion(): number {
  const source = readFileSync(path.join(worldRoot, "dist/index.js"), "utf8");
  const storage = readFileSync(path.join(worldRoot, "dist/storage.js"), "utf8");
  const bound = [...source.matchAll(/const specVersion = worldSpecVersion\(\);/g)];
  const carried = [...source.matchAll(/^\s*specVersion,$/gm)];
  const declared = [...storage.matchAll(/^\s*return SPEC_VERSION_SINGLE_ORCHESTRATOR;$/gm)];
  // Exactly one of each, or this is reading the wrong site: a second binding
  // or carrier would make "the first match" an arbitrary choice, and silently
  // answering for the wrong one is worse than failing here.
  if (bound.length !== 1 || carried.length !== 1 || declared.length !== 1) {
    throw new Error(
      `expected the World's dist to bind specVersion to worldSpecVersion() once, carry it once, and declare the single orchestrator once, found ${String(bound.length)} binding(s), ${String(carried.length)} carrier(s) and ${String(declared.length)} declaration(s)`,
    );
  }
  const { SPEC_VERSION_SINGLE_ORCHESTRATOR } = require(
    require.resolve("@workflow/world", { paths: [worldRoot] }),
  ) as { SPEC_VERSION_SINGLE_ORCHESTRATOR?: number };
  if (typeof SPEC_VERSION_SINGLE_ORCHESTRATOR !== "number") {
    throw new Error("@workflow/world does not export SPEC_VERSION_SINGLE_ORCHESTRATOR");
  }
  return SPEC_VERSION_SINGLE_ORCHESTRATOR;
}

describe("eve ↔ @evelandhq/workflow-world contract", () => {
  test("pins the platform world and the spec version it declares", () => {
    expect(worldManifest.version).toBe("1.0.0");

    // The reviewed @workflow graph the shared World bundles stays recorded;
    // see the comment above the list.
    const workspace = readSource("pnpm-workspace.yaml");
    const utilsExclusion = /^ {2}- "@workflow\/utils@([^"]+)"$/m.exec(workspace)?.[1];
    expect(utilsExclusion).toBe(worldManifest.dependencies["@workflow/utils"]);

    const { SPEC_VERSION_CURRENT: sharedSpecVersion } = require(
      require.resolve("@workflow/world", { paths: [worldRoot] }),
    ) as { SPEC_VERSION_CURRENT: number };
    // Capability and declaration, asserted separately because they differ:
    // the shared World's `@workflow/world` reports 8 as its current spec while
    // the World declares the single orchestrator (9) eve 1.0 asks for.
    expect(sharedSpecVersion).toBe(8);
    expect(declaredWorldSpecVersion()).toBe(9);
  });

  // The controls moved out of .env.example when it slimmed down to the
  // decide-per-install set; the operator reference is where a tuning knob
  // must stay discoverable.
  test("declares deployment affinity, which eve reads as per-Deployment routing", () => {
    // eve treats a World that does not declare
    // `capabilities.deploymentAffinity` as running one eve version at a time:
    // it parks or cancels deliveries for runs another eve version created and
    // ends a session such a run owns instead of resuming it. Eveland runs
    // Deployments on different eve versions side by side and its dispatcher
    // delivers every run to the Deployment recorded on it, so the injected
    // World must declare the capability, and eve must still key both guards
    // on it.
    const worldSource = readFileSync(path.join(worldRoot, "dist/index.js"), "utf8");
    expect([...worldSource.matchAll(/^\s*deploymentAffinity: true,$/gm)]).toHaveLength(1);

    const eveRoot = resolveInstalledPackageRoot("eve");
    const runtime = readFileSync(
      path.join(eveRoot, "dist/src/compiled/@workflow/core/runtime.js"),
      "utf8",
    );
    expect(runtime, "runtime affinity guard").toContain("capabilities?.deploymentAffinity");
    const runnableOwner = readFileSync(
      path.join(eveRoot, "dist/src/execution/session-inbox/runnable-owner.js"),
      "utf8",
    );
    expect(runnableOwner, "stranded-session guard").toContain(
      "capabilities?.deploymentAffinity===!0",
    );
  });

  test("declares hook force-claim, which eve's session handoff keys on", () => {
    // eve moves a session to a fresh run -- after a compaction, or onto
    // another Deployment -- by force-claiming the session's inbox hooks, and
    // only when the World declares `capabilities.hookForceClaim` together with
    // active `hookRetention`. Without them it logs "session handoff
    // unavailable" and leaves the session in its first run for life, where the
    // event log grows until the World's per-run event cap fails it. The
    // injected World must declare both, and eve's handoff must still key its
    // gate on them.
    const worldSource = readFileSync(path.join(worldRoot, "dist/index.js"), "utf8");
    expect([...worldSource.matchAll(/^\s*hookForceClaim: true,$/gm)]).toHaveLength(1);
    expect([...worldSource.matchAll(/^\s*hookRetention: \{ active: true \},$/gm)]).toHaveLength(1);

    const handoffSteps = readFileSync(
      path.join(resolveInstalledPackageRoot("eve"), "dist/src/execution/session/handoff-steps.js"),
      "utf8",
    );
    expect(handoffSteps, "handoff force-claim gate").toContain("hookForceClaim!==!0");
    expect(handoffSteps, "handoff hook-retention gate").toContain("hookRetention?.active!==!0");
  });

  test("declares atomic start Hooks, which eve needs to start a session", () => {
    // eve starts every session with `start({ experimental_hook })`, claiming
    // the session's channel address, and refuses to start one -- every
    // session, not a feature of some -- on a World that does not declare
    // `capabilities.atomicStartHook` active. The injected World must declare
    // it, and eve must still key its start on it.
    const worldSource = readFileSync(path.join(worldRoot, "dist/index.js"), "utf8");
    expect([...worldSource.matchAll(/^\s*atomicStartHook: \{ active: true \},$/gm)]).toHaveLength(
      1,
    );

    const startClaim = readFileSync(
      path.join(resolveInstalledPackageRoot("eve"), "dist/src/internal/workflow/start-claim.js"),
      "utf8",
    );
    expect(startClaim, "start-claim gate").toContain("atomicStartHook?.active!==!0");
  });

  test("exposes the bounded-storage controls in the operator reference", () => {
    const operatorReference = readSource("docs/en/reference/environment-variables.md");
    for (const name of [
      "WORKFLOW_WORLD_STREAM_COMPACTION",
      "WORKFLOW_DISPATCHER_QUEUE_GC_INTERVAL_MS",
      "WORKFLOW_DISPATCHER_TIMER_SWEEP_INTERVAL_MS",
      "WORKFLOW_DISPATCHER_MAINTENANCE_INTERVAL_MS",
      "WORKFLOW_DISPATCHER_MAINTENANCE_STREAM_BATCH_SIZE",
      "WORKFLOW_DISPATCHER_MAINTENANCE_MAX_BATCHES",
      "WORKFLOW_DISPATCHER_MAINTENANCE_MAX_STREAMS_TO_PACK",
      "WORKFLOW_DISPATCHER_MAINTENANCE_RUN_BATCH_SIZE",
    ]) {
      expect(operatorReference, `the operator reference must document ${name}`).toContain(
        `\`${name}\``,
      );
    }
  });

  test("the injected version is exactly the installed one these tests run against", () => {
    // The build-time injection constant must match the version apps/worker
    // installs: CI's contract gates run against the installed copy, so
    // injecting any other version would ship one the gates never saw.
    const injectionSource = readSource("apps/worker/src/runtime/workflow-world.ts");
    const injected =
      /EVELAND_WORKFLOW_WORLD = \{\s*packageName: "@evelandhq\/workflow-world",\s*packageVersion: "([^"]+)"/.exec(
        injectionSource,
      );
    expect(injected, "could not find EVELAND_WORKFLOW_WORLD in workflow-world.ts").not.toBeNull();
    expect(injected![1]).toBe(worldManifest.version);

    const dispatcherManifest = readJson(
      path.join(repoRoot, "apps/workflow-dispatcher/package.json"),
    ) as { dependencies?: Record<string, string> };
    expect(dispatcherManifest.dependencies?.["@evelandhq/workflow-world"]).toBe(
      `^${worldManifest.version}`,
    );

    // The attestation every new Release carries must name the generation the
    // installed World declares by default, or the activation gate would admit
    // Releases on a number these tests never verified against any eve line.
    const attestedSpec = /const EVELAND_WORKFLOW_WORLD_STORAGE_SPEC = (\d+);/.exec(injectionSource);
    expect(
      attestedSpec,
      "could not find EVELAND_WORKFLOW_WORLD_STORAGE_SPEC in workflow-world.ts",
    ).not.toBeNull();
    expect(Number(attestedSpec![1])).toBe(declaredWorldSpecVersion());

    // spec.md deliberately carries no version pins (see the spec.md guard in
    // eve-compatibility-consistency.test.ts); the pinned world versions are
    // documented in the runtime operations and Eve compatibility pages.
    for (const documentation of [
      readSource("docs/en/operations/runtime.md"),
      readSource("docs/zh/operations/runtime.md"),
      readSource("docs/en/reference/eve-compatibility.md"),
      readSource("docs/zh/reference/eve-compatibility.md"),
    ]) {
      expect(documentation).toContain(`@evelandhq/workflow-world@${worldManifest.version}`);
    }
  });

  test("the line rule rejects what eve rejects and nothing more", () => {
    const line = (version: string) => versionLine(version);
    expect(isDefiniteLineMismatch(line("5.0.0-beta.38"), line("5.0.1"))).toBe(false);
    expect(isDefiniteLineMismatch(line("5.0.1"), line("5.0.0-beta.57"))).toBe(false);
    expect(isDefiniteLineMismatch(line("5.0.0-beta.38"), line("5.0.0-beta.57"))).toBe(false);
    expect(isDefiniteLineMismatch(line("5.0.0-beta.38"), line("5.0.0-rc.1"))).toBe(true);
    expect(isDefiniteLineMismatch(line("4.1.0"), line("5.0.1"))).toBe(true);
    expect(isDefiniteLineMismatch(line("^6.0.0-beta.1"), line("5.0.1"))).toBe(true);
  });

  describe("against the installed eve", () => {
    const eveRoot = resolveInstalledPackageRoot("eve");
    const eveManifest = readJson(path.join(eveRoot, "package.json")) as {
      version: string;
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    test("the world declares a @workflow line eve accepts", () => {
      // Mirrors eve's `assertWorkflowWorldCompatibility`: it reads the first
      // of `@workflow/core` then `@workflow/world` from the world's manifest
      // and throws when the major differs, or when both carry prerelease
      // tags that differ. eve bundles @workflow/* at build time, so its own
      // declaration lives in devDependencies.
      const eveWorkflowCore =
        eveManifest.devDependencies?.["@workflow/core"] ??
        eveManifest.dependencies?.["@workflow/core"] ??
        eveManifest.peerDependencies?.["@workflow/core"];
      expect(eveWorkflowCore, `eve ${eveManifest.version} must declare @workflow/core`).toBeTypeOf(
        "string",
      );

      const declared =
        worldManifest.dependencies["@workflow/core"] ??
        worldManifest.dependencies["@workflow/world"];
      expect(declared, "the world must declare a @workflow dependency").toBeTypeOf("string");

      const world = versionLine(declared!);
      const eve = versionLine(eveWorkflowCore!);
      expect(
        isDefiniteLineMismatch(world, eve),
        `the world's ${declared} is not on the line eve ${eveManifest.version} bundles (${eveWorkflowCore})`,
      ).toBe(false);
    });

    test("the world's specVersion falls inside the range this eve release enforces", () => {
      const enforced = findEnforcedSpecVersions(path.join(eveRoot, "dist"));
      expect(
        enforced,
        `could not find eve ${eveManifest.version}'s spec-version guard`,
      ).toBeDefined();

      // The declared number, not the package's current one: eve compares the
      // `specVersion` the World hands it, and the two have differed before
      // (0.15.0 through 0.17.0 declared 6 on a package whose current was 7).
      const declared = declaredWorldSpecVersion();
      expect(declared).toBeGreaterThanOrEqual(enforced!.min);
      expect(declared).toBeLessThanOrEqual(enforced!.max);
    });
  });

  test("the vqs header names the dispatcher hardcodes still match world-local's parser", () => {
    // The dispatcher writes these headers by hand; the world's own
    // `@workflow/world-local` parses them on the executor side. A rename
    // upstream would be a silent 400 on every dispatch.
    const worldLocalDist = path.dirname(
      require.resolve("@workflow/world-local", { paths: [worldRoot] }),
    );
    const parserSource = readFileSync(path.join(worldLocalDist, "queue.js"), "utf8");
    // The header constants live in the world's shared dispatch-contract module,
    // outside dist/dispatcher/, so the sender side scans the whole dist.
    const worldSource = walkJsFiles(path.join(worldRoot, "dist"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    for (const header of [
      "x-vqs-queue-name",
      "x-vqs-message-id",
      "x-vqs-message-attempt",
      "x-vqs-message-delivery-count",
    ]) {
      expect(parserSource, `world-local no longer parses ${header}`).toContain(header);
      expect(worldSource, `the world no longer names ${header}`).toContain(header);
    }
  });

  test('the dispatcher requests activation kind "workflow_step"', () => {
    // The fourth place of activation-kind-contract.test.ts: the literal the
    // caller actually sends, read from the installed package rather than a
    // repo path because the dispatcher ships inside @evelandhq/workflow-world.
    const dispatcherSource = walkJsFiles(path.join(worldRoot, "dist", "dispatcher"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(dispatcherSource).toContain('kind: "workflow_step"');
  });
});
