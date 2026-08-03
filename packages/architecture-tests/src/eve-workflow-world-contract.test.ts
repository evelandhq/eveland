import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * The compatibility surface between `@eveland/workflow-world` and the eve
 * release the platform installs into deployments.
 *
 * These assertions exist because eve enforces the contract in two places that
 * both move independently of us:
 *
 *   1. `validateWorkflowWorld` compares the world package's declared
 *      `@workflow/*` dependency line against the one eve bundles;
 *   2. the runtime rejects any world whose `specVersion` is not the exact
 *      number compiled into that eve release.
 *
 * Neither is a type error, so without this suite an eve bump would fail at
 * deploy time on a real project instead of in CI.
 */
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "../../..");

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

/**
 * Anchored at the workspace that actually declares each dependency. pnpm does
 * not hoist to the repo root, and resolving from there would silently walk up
 * out of the worktree into the parent checkout's node_modules.
 */
const RESOLUTION_ANCHORS: Record<string, string> = {
  eve: "packages/sandbox-bwrap",
  "@workflow/world": "packages/workflow-world",
  "@workflow/world-local": "packages/workflow-world",
  "@workflow/utils": "packages/workflow-world",
};

function resolveInstalled(specifier: string): string {
  const packageName = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0]!;
  const anchor = RESOLUTION_ANCHORS[packageName];
  if (!anchor) throw new Error(`no resolution anchor registered for ${packageName}`);
  return require.resolve(specifier, { paths: [path.join(repoRoot, anchor)] });
}

const worldManifest = readJson(path.join(repoRoot, "packages/workflow-world/package.json")) as {
  dependencies: Record<string, string>;
};

describe("eve ↔ @eveland/workflow-world contract", () => {
  test("the world declares the same @workflow major and prerelease line eve bundles", () => {
    // Mirrors eve's `assertWorkflowWorldCompatibility`: it reads the first of
    // `@workflow/core` then `@workflow/world` from the world's manifest and
    // throws when the major differs, or when both carry prerelease tags that
    // differ.
    // eve's own `readWorkflowVersionFromManifest` looks in devDependencies
    // first, then dependencies, then peerDependencies — and eve bundles
    // @workflow/* at build time, so devDependencies is where it actually lives.
    const eveManifest = readJson(resolveInstalled("eve/package.json")) as {
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const eveWorkflowCore =
      eveManifest.devDependencies?.["@workflow/core"] ??
      eveManifest.dependencies?.["@workflow/core"] ??
      eveManifest.peerDependencies?.["@workflow/core"];
    expect(eveWorkflowCore, "eve must declare @workflow/core").toBeTypeOf("string");

    const declared =
      worldManifest.dependencies["@workflow/core"] ?? worldManifest.dependencies["@workflow/world"];
    expect(declared, "the world must declare a @workflow dependency").toBeTypeOf("string");

    expect(versionLine(declared!)).toEqual(versionLine(eveWorkflowCore!));
  });

  test("the world's specVersion equals the literal this eve release enforces", () => {
    // eve compiles `if (world.specVersion !== N) throw` per release rather than
    // comparing against an imported constant, so the number is read back out of
    // the shipped bundle.
    const eveEntry = resolveInstalled("eve/package.json");
    const eveRoot = path.dirname(eveEntry);
    const enforced = findEnforcedSpecVersion(path.join(eveRoot, "dist"));
    expect(enforced, "could not find eve's spec-version guard").toBeTypeOf("number");

    const { SPEC_VERSION_CURRENT } = require(resolveInstalled("@workflow/world")) as {
      SPEC_VERSION_CURRENT: number;
    };
    expect(SPEC_VERSION_CURRENT).toBe(enforced);
  });

  test("the vqs header names and route base the dispatcher hardcodes still match eve's", () => {
    // The dispatcher writes these headers by hand; eve's world-local parses
    // them. A rename upstream would be a silent 400 on every dispatch.
    const worldLocalDist = path.dirname(resolveInstalled("@workflow/world-local"));
    const queueSource = readFileSync(path.join(worldLocalDist, "queue.js"), "utf8");
    for (const header of ["x-vqs-queue-name", "x-vqs-message-id", "x-vqs-message-attempt"]) {
      expect(queueSource, `world-local no longer reads ${header}`).toContain(header);
    }

    const utilsDist = path.dirname(resolveInstalled("@workflow/utils"));
    const routes = readFileSync(path.join(utilsDist, "workflow-routes.js"), "utf8");
    expect(routes).toContain("/.well-known/workflow/v1");
  });

  test("eve still resolves a bare package specifier as a world import", () => {
    // `resolveWorkflowWorldImport` special-cases only 'local' and 'vercel';
    // everything else is passed through as an import specifier. That
    // pass-through is how `@eveland/workflow-world` gets injected at all.
    const eveRoot = path.dirname(resolveInstalled("eve/package.json"));
    const source = readFileSync(
      path.join(eveRoot, "dist/src/internal/workflow/world-target.js"),
      "utf8",
    );
    expect(source).toContain("@workflow/world-local");
    expect(source).toContain("@workflow/world-vercel");
  });
});

/** `5.0.0-beta.19` → `{ major: 5, tag: "beta" }`, matching eve's parser. */
function versionLine(range: string): { major: number; tag: string | undefined } {
  const match = /(\d+)\.(?:\d+|x|\*)(?:\.(?:\d+|x|\*))?(?:-([0-9A-Za-z.-]+))?/.exec(range.trim());
  if (!match) throw new Error(`unparseable version range: ${range}`);
  return { major: Number(match[1]), tag: match[2]?.split(".")[0] };
}

function findEnforcedSpecVersion(distDir: string): number | undefined {
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  const hits = execFileSync("grep", ["-rho", "specVersion!==[0-9]\\+", distDir], {
    encoding: "utf8",
  }).trim();
  const first = hits.split("\n")[0];
  const value = first ? Number(first.replace("specVersion!==", "")) : Number.NaN;
  return Number.isInteger(value) ? value : undefined;
}
