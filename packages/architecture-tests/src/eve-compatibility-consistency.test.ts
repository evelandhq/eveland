import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  EVE_COMPATIBILITY_POLICY,
  LATEST_VERIFIED_EVE_VERSION,
  SUPPORTED_EVE_VERSION_RANGES,
  VERIFIED_EVE_VERSIONS,
} from "@eveland/core/eve-compatibility";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

function repositoryFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, `file://${repositoryRoot}/`), "utf8");
}

function normalizedWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

describe("Eve compatibility repository contract", () => {
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

  test("describes a valid sliding compatibility window", () => {
    const { supportedLines, peerDependencyRange } = EVE_COMPATIBILITY_POLICY;
    const stableDependencyNames = ["eve-oldest", "eve-middle", "eve"];
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

    expect(supportedLines).toHaveLength(3);
    expect(new Set(minorNumbers).size).toBe(3);
    expect(minorNumbers).toEqual(minorNumbers.map((_, index) => minorNumbers[0]! + index));
    expect(peerDependencyRange).toBe(`>=0.${minorNumbers[0]}.0 <0.${minorNumbers.at(-1)! + 1}.0`);
  });

  test("derives public compatibility values from the policy", async () => {
    const compatibility = await import("@eveland/core/eve-compatibility");
    const expectedRanges = EVE_COMPATIBILITY_POLICY.supportedLines.map(({ range }) => range);
    const expectedVersions = EVE_COMPATIBILITY_POLICY.supportedLines.map(
      ({ verifiedVersion }) => verifiedVersion,
    );

    expect(compatibility.SUPPORTED_EVE_VERSION_RANGES).toEqual(expectedRanges);
    expect(compatibility.VERIFIED_EVE_VERSIONS).toEqual(expectedVersions);
    expect(compatibility.LATEST_VERIFIED_EVE_VERSION).toBe(expectedVersions.at(-1));
    expect(compatibility.SUPPORTED_EVE_VERSION_RANGE).toBe(
      `${expectedRanges.slice(0, -1).join(", ")}, or ${expectedRanges.at(-1)}`,
    );
  });

  test("makes the source scanner consume the compatibility policy", async () => {
    const compatibility = await import("@eveland/core/eve-compatibility");
    const source = await import("@eveland/core/source");

    expect(source.SUPPORTED_EVE_VERSION_RANGES).toBe(compatibility.SUPPORTED_EVE_VERSION_RANGES);
  });

  test("makes the source scanner delegate compatibility decisions", async () => {
    const compatibility = await import("@eveland/core/eve-compatibility");
    const source = await import("@eveland/core/source");

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
    expect(workspace).toContain(
      `  eve-peer:\n    eve: "${EVE_COMPATIBILITY_POLICY.peerDependencyRange}"`,
    );

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
        // Two contracts, deliberately not one. sandbox-bwrap implements
        // SandboxBackend and is vendored into every Release, so it tracks
        // exactly what the platform can host. The published SDK imports four
        // auth primitives and versions on its own; see eve-sdk-peer.
        expect(packageJson.peerDependencies.eve, packagePath).toBe(
          packagePath === "packages/sdk/package.json" ? "catalog:eve-sdk-peer" : "catalog:eve-peer",
        );
      }
    }

    expect([...latestConsumers].sort()).toEqual([
      "apps/web/package.json",
      "packages/agent-auth/package.json",
      "packages/agent-observer/package.json",
      "packages/agent-scheduler/package.json",
      "packages/sandbox-bwrap/package.json",
      "packages/sdk/package.json",
    ]);
    expect([...legacyMatrixConsumers].sort()).toEqual([
      "packages/agent-observer/package.json",
      "packages/agent-scheduler/package.json",
      "packages/sandbox-bwrap/package.json",
    ]);
    expect([...standaloneFixtureConsumers].sort()).toEqual([
      "apps/worker/src/integration/fixtures/agent-sandbox-e2e/package.json",
      "apps/worker/src/integration/fixtures/connections-e2e/package.json",
      "apps/worker/src/integration/fixtures/observer-e2e/package.json",
      "infra/integration/fixtures/schedule-scale-zero/package.json",
    ]);
    expect([...peerConsumers].sort()).toEqual([
      "packages/sandbox-bwrap/package.json",
      "packages/sdk/package.json",
    ]);
  });

  test("keeps active documentation references aligned with policy", () => {
    const latestRange = SUPPORTED_EVE_VERSION_RANGES.at(-1)!;
    const quotedVerifiedVersions = VERIFIED_EVE_VERSIONS.map((version) => `\`${version}\``);
    const verifiedEnglish = `${quotedVerifiedVersions.slice(0, -1).join(", ")}, and ${quotedVerifiedVersions.at(-1)}`;
    const quotedVerifiedVersionsChinese = VERIFIED_EVE_VERSIONS.map((version) => `\`${version}\``);
    const verifiedChinese = `${quotedVerifiedVersionsChinese.slice(0, -1).join("、")} 与 ${quotedVerifiedVersionsChinese.at(-1)}`;
    const englishDocs = normalizedWhitespace(
      repositoryFile("apps/docs/content/docs/en/reference/eve-compatibility.mdx"),
    );
    const chineseDocs = normalizedWhitespace(
      repositoryFile("apps/docs/content/docs/zh/reference/eve-compatibility.mdx"),
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
    const [oldest, middle, latest] = SUPPORTED_EVE_VERSION_RANGES;
    const exactMinors = SUPPORTED_EVE_VERSION_RANGES.map((range) => range.replace(/\.x$/, "")).join(
      "/",
    );
    const spec = normalizedWhitespace(repositoryFile("docs/spec.md"));
    const englishDocs = normalizedWhitespace(
      repositoryFile("apps/docs/content/docs/en/reference/eve-compatibility.mdx"),
    );
    const chineseDocs = normalizedWhitespace(
      repositoryFile("apps/docs/content/docs/zh/reference/eve-compatibility.mdx"),
    );

    expect(spec).toContain(
      `当前窗口是 ${oldest}、${middle} 与 ${latest}。允许精确的 ${exactMinors} patch`,
    );
    expect(englishDocs).toContain(`supports \`${oldest}\`, \`${middle}\`, and \`${latest}\``);
    expect(chineseDocs).toContain(`支持 \`${oldest}\`、\`${middle}\` 与 \`${latest}\``);
  });
});
