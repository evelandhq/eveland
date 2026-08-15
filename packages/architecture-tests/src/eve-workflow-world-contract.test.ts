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
 * injects — and the eve lines from `packages/agent-observer`, which installs
 * both supported lines for its own compatibility tests.
 */
const require = createRequire(import.meta.url);

/**
 * Anchored at the workspace that actually declares each dependency. pnpm does
 * not hoist to the repo root, and resolving from there would silently walk up
 * out of the worktree into the parent checkout's node_modules.
 */
const RESOLUTION_ANCHORS: Record<string, string> = {
  "@evelandhq/workflow-world": "apps/worker",
  "@workflow/world-postgres": "apps/worker",
  eve: "packages/agent-observer",
  "eve-oldest": "packages/agent-observer",
};

/** The supported eve lines, newest first; alias names are pnpm catalog entries. */
const EVE_LINES = ["eve", "eve-oldest"] as const;

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
const postgresWorldRoot = resolveInstalledPackageRoot("@workflow/world-postgres");
const postgresWorldManifest = readJson(path.join(postgresWorldRoot, "package.json")) as {
  version: string;
};

describe("eve ↔ @evelandhq/workflow-world contract", () => {
  test("pins the spec-v6 platform worlds reviewed for Eve 0.38.3", () => {
    expect(worldManifest.version).toBe("0.6.0");
    expect(postgresWorldManifest.version).toBe("5.0.0-beta.34");

    const { SPEC_VERSION_CURRENT: sharedSpecVersion } = require(
      require.resolve("@workflow/world", { paths: [worldRoot] }),
    ) as { SPEC_VERSION_CURRENT: number };
    const { SPEC_VERSION_CURRENT: postgresSpecVersion } = require(
      require.resolve("@workflow/world", { paths: [postgresWorldRoot] }),
    ) as { SPEC_VERSION_CURRENT: number };
    expect(sharedSpecVersion).toBe(6);
    expect(postgresSpecVersion).toBe(6);
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

    const postgresInjected =
      /PLATFORM_WORKFLOW_WORLD = \{\s*packageName: "@workflow\/world-postgres",\s*packageVersion: "([^"]+)"/.exec(
        injectionSource,
      );
    expect(
      postgresInjected,
      "could not find PLATFORM_WORKFLOW_WORLD in workflow-world.ts",
    ).not.toBeNull();
    expect(postgresInjected![1]).toBe(postgresWorldManifest.version);
  });

  for (const line of EVE_LINES) {
    describe(`against ${line}`, () => {
      // Non-default names are pnpm catalog aliases for pinned Eve lines.
      const eveRoot = resolveInstalledPackageRoot(line, "eve");
      const eveManifest = readJson(path.join(eveRoot, "package.json")) as {
        version: string;
        devDependencies?: Record<string, string>;
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };

      test("the world declares the same @workflow major and prerelease line eve bundles", () => {
        // Mirrors eve's `assertWorkflowWorldCompatibility`: it reads the first
        // of `@workflow/core` then `@workflow/world` from the world's manifest
        // and throws when the major differs, or when both carry prerelease
        // tags that differ. eve bundles @workflow/* at build time, so its own
        // declaration lives in devDependencies.
        const eveWorkflowCore =
          eveManifest.devDependencies?.["@workflow/core"] ??
          eveManifest.dependencies?.["@workflow/core"] ??
          eveManifest.peerDependencies?.["@workflow/core"];
        expect(
          eveWorkflowCore,
          `eve ${eveManifest.version} must declare @workflow/core`,
        ).toBeTypeOf("string");

        const declared =
          worldManifest.dependencies["@workflow/core"] ??
          worldManifest.dependencies["@workflow/world"];
        expect(declared, "the world must declare a @workflow dependency").toBeTypeOf("string");

        expect(versionLine(declared!)).toEqual(versionLine(eveWorkflowCore!));
      });

      test("the world's specVersion falls inside the range this eve release enforces", () => {
        const enforced = findEnforcedSpecVersions(path.join(eveRoot, "dist"));
        expect(
          enforced,
          `could not find eve ${eveManifest.version}'s spec-version guard`,
        ).toBeDefined();

        const { SPEC_VERSION_CURRENT } = require(
          require.resolve("@workflow/world", { paths: [worldRoot] }),
        ) as { SPEC_VERSION_CURRENT: number };
        expect(SPEC_VERSION_CURRENT).toBeGreaterThanOrEqual(enforced!.min);
        expect(SPEC_VERSION_CURRENT).toBeLessThanOrEqual(enforced!.max);
      });
    });
  }

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
    for (const header of ["x-vqs-queue-name", "x-vqs-message-id", "x-vqs-message-attempt"]) {
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
