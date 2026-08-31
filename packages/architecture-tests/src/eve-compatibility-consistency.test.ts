import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  EVE_COMPATIBILITY_POLICY,
  LATEST_VERIFIED_EVE_VERSION,
  SUPPORTED_EVE_VERSION_RANGES,
  VERIFIED_EVE_VERSIONS,
} from "@evelandhq/core/eve-compatibility";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

function repositoryFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, `file://${repositoryRoot}/`), "utf8");
}

function normalizedWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function englishList(values: readonly string[]): string {
  if (values.length < 2) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function chineseList(values: readonly string[]): string {
  if (values.length < 2) return values[0] ?? "";
  return `${values.slice(0, -1).join("、")} 与 ${values.at(-1)}`;
}

describe("Eve compatibility repository contract", () => {
  test("pins the latest verified Eve patch reviewed for this release", () => {
    expect(LATEST_VERIFIED_EVE_VERSION).toBe("0.47.6");
  });

  test("keeps the stable Eve workflow retention audit exhaustive", () => {
    const coveredStableWorkflowConstants = [
      "WORKFLOW_ENTRY_NAME",
      "TURN_WORKFLOW_NAME",
      "SESSION_TIMEOUT_WORKFLOW_NAME",
      "TASK_RUN_WORKFLOW_NAME",
      // 0.47.3: the activity collector run behind `POST /eve/v1/activity/:token`.
      // Audited 2026-08-29: started only for parentless sessions whose channel
      // declares activity renderers, as a ROOT run (no lineage, no explicit
      // class) with an `expiresAt` bounded by sessionTimeoutMs (default 24h),
      // so it terminates and the interactive-class deadlines clean it up like
      // the session-timeout run; a batch arriving after cleanup gets the
      // route's own 404, not a retention error.
      "ACTIVITY_COLLECTOR_WORKFLOW_NAME",
    ];

    // The covered list is the union across the window: a line may predate a
    // stable workflow (0.45.x has no activity collector), but every stable
    // workflow any supported line runs must be audited, and the list must not
    // keep entries no line runs anymore.
    const observedConstants = new Set<string>();
    for (const { dependencyName } of EVE_COMPATIBILITY_POLICY.supportedLines) {
      const runtimeSource = repositoryFile(
        `packages/agent-scheduler/node_modules/${dependencyName}/dist/src/execution/workflow-runtime.js`,
      );
      const stableSet = /STABLE_WORKFLOW_NAMES=new Set\(\[([^\]]+)\]\)/.exec(runtimeSource)?.[1];
      expect(stableSet, dependencyName).toBeDefined();
      for (const constant of stableSet!.split(",")) {
        observedConstants.add(constant);
        expect(coveredStableWorkflowConstants, `${dependencyName} runs ${constant}`).toContain(
          constant,
        );
      }

      const lineageContract = repositoryFile(
        `packages/agent-scheduler/node_modules/${dependencyName}/dist/src/compiled/@workflow/world/attributes.d.ts`,
      );
      expect(lineageContract, dependencyName).toContain('ROOT_RUN_ID_ATTRIBUTE = "$rootRunId"');
      expect(lineageContract, dependencyName).toContain('PARENT_RUN_ID_ATTRIBUTE = "$parentRunId"');
    }
    expect([...observedConstants].sort()).toEqual([...coveredStableWorkflowConstants].sort());
  });

  test("publishes a browser-safe compatibility policy subpath", () => {
    const corePackage = JSON.parse(repositoryFile("packages/core/package.json")) as {
      exports?: Record<string, string>;
    };

    expect(corePackage.exports?.["./eve-compatibility"]).toBe("./src/eve-compatibility.ts");
  });

  test("publishes the Node-only Eve fixture materializer subpath", () => {
    const corePackage = JSON.parse(repositoryFile("packages/core/package.json")) as {
      exports?: Record<string, string>;
    };

    expect(corePackage.exports?.["./server/eve-fixture"]).toBe("./src/server/eve-fixture.ts");
  });

  test("describes the supported 0.45/0.47 compatibility window", () => {
    const { supportedLines, peerDependencyRange } = EVE_COMPATIBILITY_POLICY;
    const stableDependencyNames = ["eve-oldest", "eve"];
    const minorNumbers = supportedLines.map((line, index) => {
      const rangeMatch = /^0\.(\d+)\.x$/.exec(line.range);
      const verifiedMatch = /^0\.(\d+)\.(\d+)$/.exec(line.verifiedVersion);
      if (!rangeMatch || !verifiedMatch) {
        throw new Error(`Invalid Eve compatibility line: ${line.range} / ${line.verifiedVersion}`);
      }

      const minor = Number(rangeMatch[1]);
      expect(Number(verifiedMatch[1]), line.range).toBe(minor);
      expect(line.dependencyName, line.range).toBe(stableDependencyNames[index]);
      return minor;
    });

    expect(supportedLines).toHaveLength(2);
    // Lines are strictly ascending but need not be contiguous: a minor that
    // was superseded before it could host a real deployment may be skipped
    // (0.40/0.41 were replaced by 0.42 within 48 hours of release, 0.43 by
    // 0.44 within four hours). Each skip
    // must be re-justified: it is only safe when every wire format is
    // byte-identical across the whole span, so mixed-window pairs stay
    // trivially compatible.
    expect(minorNumbers).toEqual([...minorNumbers].sort((a, b) => a - b));
    expect(new Set(minorNumbers).size).toBe(minorNumbers.length);

    // The peer range is the union of maximal contiguous runs of supported
    // minors -- never their hull, which would admit skipped lines.
    const contiguousRuns: number[][] = [];
    for (const minor of minorNumbers) {
      const run = contiguousRuns.at(-1);
      if (run && minor === run.at(-1)! + 1) run.push(minor);
      else contiguousRuns.push([minor]);
    }
    expect(peerDependencyRange).toBe(
      contiguousRuns.map((run) => `>=0.${run[0]}.0 <0.${run.at(-1)! + 1}.0`).join(" || "),
    );
  });

  test("derives public compatibility values from the policy", async () => {
    const compatibility = await import("@evelandhq/core/eve-compatibility");
    const expectedRanges = EVE_COMPATIBILITY_POLICY.supportedLines.map(({ range }) => range);
    const expectedVersions = EVE_COMPATIBILITY_POLICY.supportedLines.map(
      ({ verifiedVersion }) => verifiedVersion,
    );

    expect(compatibility.SUPPORTED_EVE_VERSION_RANGES).toEqual(expectedRanges);
    expect(compatibility.VERIFIED_EVE_VERSIONS).toEqual(expectedVersions);
    expect(compatibility.LATEST_VERIFIED_EVE_VERSION).toBe(expectedVersions.at(-1));
    expect(compatibility.SUPPORTED_EVE_VERSION_RANGE).toBe(
      expectedRanges.length === 2
        ? `${expectedRanges[0]} or ${expectedRanges[1]}`
        : `${expectedRanges.slice(0, -1).join(", ")}, or ${expectedRanges.at(-1)}`,
    );
  });

  test("makes the source scanner consume the compatibility policy", async () => {
    const compatibility = await import("@evelandhq/core/eve-compatibility");
    const source = await import("@evelandhq/core/source");

    expect(source.SUPPORTED_EVE_VERSION_RANGES).toBe(compatibility.SUPPORTED_EVE_VERSION_RANGES);
  });

  test("makes the source scanner delegate compatibility decisions", async () => {
    const compatibility = await import("@evelandhq/core/eve-compatibility");
    const source = await import("@evelandhq/core/source");

    expect(source.isSupportedEveDependency).toBe(compatibility.isSupportedEveDependency);
    expect(source.unsupportedEveVersionMessage).toBe(compatibility.unsupportedEveVersionMessage);
    expect(source.createEveVersionInfo).toBe(compatibility.createEveVersionInfo);
  });

  test("routes repository Eve dependencies through the compatibility catalogs", () => {
    const workspace = repositoryFile("pnpm-workspace.yaml");
    const [latestLine, ...legacyLines] = [...EVE_COMPATIBILITY_POLICY.supportedLines].reverse();

    expect(workspace).toContain(`catalog:\n  eve: ${latestLine!.verifiedVersion}`);
    for (const line of legacyLines.reverse()) {
      expect(workspace).toContain(`    ${line.dependencyName}: npm:eve@${line.verifiedVersion}`);
    }
    // No eve-peer catalog is asserted: sandbox-bwrap was its only consumer and
    // now lives in its own repository with its own, deliberately wider peer
    // range. peerDependencyRange still describes the platform's hosting window
    // and still pins the SDK floor below.

    // The SDK's ceiling is deliberately independent of the platform window, but
    // its floor is not: advertising support for a line Eveland can no longer
    // host would point developers at an Agent that cannot be deployed.
    const sdkPeerRange = /\n {2}eve-sdk-peer:\n {4}eve: "([^"]+)"/.exec(workspace)?.[1];
    const policyFloor = /^(>=\d+\.\d+\.\d+)/.exec(
      EVE_COMPATIBILITY_POLICY.peerDependencyRange,
    )?.[1];
    expect(sdkPeerRange, "eve-sdk-peer must be declared").toBeDefined();
    expect(sdkPeerRange).toContain(policyFloor!);

    const packagePaths = globSync(
      ["apps/**/package.json", "packages/**/package.json", "infra/**/package.json"],
      {
        cwd: repositoryRoot,
        exclude: ["**/node_modules/**", "**/.next/**"],
      },
    );
    const latestConsumers = new Set<string>();
    const legacyMatrixConsumers = new Set<string>();
    const standaloneFixtureConsumers = new Set<string>();
    const peerConsumers = new Set<string>();
    const matrixDependencyNames = new Set<string>(
      EVE_COMPATIBILITY_POLICY.supportedLines.map(({ dependencyName }) => dependencyName),
    );
    for (const packagePath of packagePaths) {
      const packageJson = JSON.parse(repositoryFile(packagePath)) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      const isWorkspacePackage = /^(?:apps|packages)\/[^/]+\/package\.json$/.test(packagePath);
      const isPublishedSdk = packagePath === "packages/sdk/package.json";
      for (const dependencies of [packageJson.dependencies, packageJson.devDependencies]) {
        for (const dependencyName of Object.keys(dependencies ?? {}).filter((name) =>
          matrixDependencyNames.has(name),
        )) {
          if (isWorkspacePackage && dependencyName === "eve") {
            latestConsumers.add(packagePath);
          } else if (isWorkspacePackage) {
            legacyMatrixConsumers.add(packagePath);
          } else {
            standaloneFixtureConsumers.add(packagePath);
          }
          expect(dependencies?.[dependencyName], packagePath).toBe(
            isWorkspacePackage
              ? dependencyName === "eve"
                ? isPublishedSdk
                  ? latestLine!.verifiedVersion
                  : "catalog:"
                : "catalog:eve-matrix"
              : "catalog:",
          );
        }
      }
      if (packageJson.peerDependencies?.eve !== undefined) {
        peerConsumers.add(packagePath);
        // The SDK is the only workspace package that declares an eve peer. Its
        // source manifest uses the catalog's resolved range literally because
        // npm publish does not understand pnpm's catalog: protocol. This test
        // keeps the npm-safe duplicate synchronized with eve-sdk-peer.
        expect(packageJson.peerDependencies.eve, packagePath).toBe(sdkPeerRange);
      }
    }

    expect([...latestConsumers].sort()).toEqual([
      "apps/web/package.json",
      "packages/agent-auth/package.json",
      "packages/agent-observer/package.json",
      "packages/agent-scheduler/package.json",
      "packages/sdk/package.json",
    ]);
    expect([...legacyMatrixConsumers].sort()).toEqual([
      "packages/agent-observer/package.json",
      "packages/agent-scheduler/package.json",
    ]);
    expect([...standaloneFixtureConsumers].sort()).toEqual([
      "apps/worker/src/integration/fixtures/agent-sandbox-e2e/package.json",
      "apps/worker/src/integration/fixtures/connections-e2e/package.json",
      "apps/worker/src/integration/fixtures/identity-e2e/package.json",
      "apps/worker/src/integration/fixtures/observer-e2e/package.json",
      "infra/integration/fixtures/schedule-scale-zero/package.json",
      "infra/integration/fixtures/workflow-wake/package.json",
    ]);
    expect([...peerConsumers].sort()).toEqual(["packages/sdk/package.json"]);
  });

  test("keeps the published SDK manifest installable by npm before packing", () => {
    const workspace = repositoryFile("pnpm-workspace.yaml");
    const sdkPeerRange = /\n {2}eve-sdk-peer:\n {4}eve: "([^"]+)"/.exec(workspace)?.[1];
    const sdkPackage = JSON.parse(repositoryFile("packages/sdk/package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    expect(sdkPeerRange, "eve-sdk-peer must be declared").toBeDefined();
    expect(sdkPackage.devDependencies?.eve).toBe(LATEST_VERIFIED_EVE_VERSION);
    expect(sdkPackage.peerDependencies?.eve).toBe(sdkPeerRange);

    const publishedSpecifiers = Object.values({
      ...sdkPackage.dependencies,
      ...sdkPackage.devDependencies,
      ...sdkPackage.optionalDependencies,
      ...sdkPackage.peerDependencies,
    });
    expect(publishedSpecifiers.filter((specifier) => specifier.startsWith("catalog:"))).toEqual([]);
  });

  test("keeps active documentation references aligned with policy", () => {
    const latestRange = SUPPORTED_EVE_VERSION_RANGES.at(-1)!;
    const quotedVerifiedVersions = VERIFIED_EVE_VERSIONS.map((version) => `\`${version}\``);
    const verifiedEnglish = englishList(quotedVerifiedVersions);
    const quotedVerifiedVersionsChinese = VERIFIED_EVE_VERSIONS.map((version) => `\`${version}\``);
    const verifiedChinese = chineseList(quotedVerifiedVersionsChinese);
    const englishDocs = normalizedWhitespace(
      repositoryFile("docs/en/reference/eve-compatibility.md"),
    );
    const chineseDocs = normalizedWhitespace(
      repositoryFile("docs/zh/reference/eve-compatibility.md"),
    );

    expect(englishDocs).toContain(`verified at ${verifiedEnglish}`);
    expect(englishDocs).toContain(
      `marks only the latest supported line, \`${latestRange}\`, in green`,
    );
    expect(englishDocs).toContain(
      `refresh their lockfile and redeploy to receive \`${LATEST_VERIFIED_EVE_VERSION}\``,
    );
    expect(chineseDocs).toContain(`验证版本为 ${verifiedChinese}`);
    expect(chineseDocs).toContain(`UI 仅将最新支持线 \`${latestRange}\` 标为绿色`);
    expect(chineseDocs).toContain(`才能实际获得 \`${LATEST_VERIFIED_EVE_VERSION}\``);
  });

  test("keeps the active product and public documentation windows aligned", () => {
    const quotedRanges = SUPPORTED_EVE_VERSION_RANGES.map((range) => `\`${range}\``);
    const englishRanges = englishList(quotedRanges);
    const chineseRanges = chineseList(quotedRanges);
    const englishDocs = normalizedWhitespace(
      repositoryFile("docs/en/reference/eve-compatibility.md"),
    );
    const chineseDocs = normalizedWhitespace(
      repositoryFile("docs/zh/reference/eve-compatibility.md"),
    );

    expect(englishDocs).toContain(`supports ${englishRanges}`);
    expect(chineseDocs).toContain(`支持 ${chineseRanges}`);
  });

  test("keeps spec.md free of version facts", () => {
    // spec.md is the version-stable product contract: the supported Eve
    // window, verified patches, and injected workflow-world pins live only in
    // docs/{en,zh}/reference/eve-compatibility.md (and the runtime operations
    // docs), so widening or sliding the window never edits spec.md.
    const spec = repositoryFile("spec.md");
    const literals = [
      ...SUPPORTED_EVE_VERSION_RANGES.map((range) => range.replace(/\.x$/, "")),
      ...VERIFIED_EVE_VERSIONS,
    ];
    for (const literal of literals) {
      expect(spec, `spec.md must not carry the Eve version literal ${literal}`).not.toContain(
        literal,
      );
    }
    expect(spec).not.toMatch(/@evelandhq\/workflow-world@\d/);
    expect(spec).not.toMatch(/@workflow\/world-postgres@\d/);
  });
});
