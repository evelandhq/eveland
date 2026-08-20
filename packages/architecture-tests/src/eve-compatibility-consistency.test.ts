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
    expect(LATEST_VERIFIED_EVE_VERSION).toBe("0.39.3");
  });

  test("keeps the stable Eve workflow retention audit exhaustive", () => {
    const coveredStableWorkflowConstants = [
      "WORKFLOW_ENTRY_NAME",
      "TURN_WORKFLOW_NAME",
      "SESSION_TIMEOUT_WORKFLOW_NAME",
      "TASK_RUN_WORKFLOW_NAME",
    ];

    for (const { dependencyName } of EVE_COMPATIBILITY_POLICY.supportedLines) {
      const runtimeSource = repositoryFile(
        `packages/agent-scheduler/node_modules/${dependencyName}/dist/src/execution/workflow-runtime.js`,
      );
      const stableSet = /STABLE_WORKFLOW_NAMES=new Set\(\[([^\]]+)\]\)/.exec(runtimeSource)?.[1];
      expect(stableSet, dependencyName).toBeDefined();
      expect(stableSet!.split(","), dependencyName).toEqual(coveredStableWorkflowConstants);

      const lineageContract = repositoryFile(
        `packages/agent-scheduler/node_modules/${dependencyName}/dist/src/compiled/@workflow/world/attributes.d.ts`,
      );
      expect(lineageContract, dependencyName).toContain('ROOT_RUN_ID_ATTRIBUTE = "$rootRunId"');
      expect(lineageContract, dependencyName).toContain('PARENT_RUN_ID_ATTRIBUTE = "$parentRunId"');
    }
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

  test("describes the supported 0.38-0.39 compatibility window", () => {
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
    expect(new Set(minorNumbers).size).toBe(2);
    expect(minorNumbers).toEqual(minorNumbers.map((_, index) => minorNumbers[0]! + index));
    expect(peerDependencyRange).toBe(`>=0.${minorNumbers[0]}.0 <0.${minorNumbers.at(-1)! + 1}.0`);
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
                ? "catalog:"
                : "catalog:eve-matrix"
              : "catalog:",
          );
        }
      }
      if (packageJson.peerDependencies?.eve !== undefined) {
        peerConsumers.add(packagePath);
        // The SDK is the only workspace package that declares an eve peer. It
        // imports four auth primitives and versions on its own; see
        // eve-sdk-peer. sandbox-bwrap used to be the second such package,
        // tracking exactly what the platform could host, but it now ships from
        // its own repository and sets its own range.
        expect(packageJson.peerDependencies.eve, packagePath).toBe("catalog:eve-sdk-peer");
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
    const specRanges = chineseList(SUPPORTED_EVE_VERSION_RANGES);
    const exactMinors = SUPPORTED_EVE_VERSION_RANGES.map((range) => range.replace(/\.x$/, "")).join(
      "/",
    );
    const spec = normalizedWhitespace(repositoryFile("spec.md"));
    const englishDocs = normalizedWhitespace(
      repositoryFile("docs/en/reference/eve-compatibility.md"),
    );
    const chineseDocs = normalizedWhitespace(
      repositoryFile("docs/zh/reference/eve-compatibility.md"),
    );

    expect(spec).toContain(`当前窗口是 ${specRanges}。允许精确的 ${exactMinors} patch`);
    expect(englishDocs).toContain(`supports ${englishRanges}`);
    expect(chineseDocs).toContain(`支持 ${chineseRanges}`);
  });
});
