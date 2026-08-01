import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  EVE_COMPATIBILITY_POLICY,
  LATEST_VERIFIED_EVE_VERSION,
  SUPPORTED_EVE_VERSION_RANGES,
  VERIFIED_EVE_VERSIONS,
} from "./eve-compatibility.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

function repositoryFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, `file://${repositoryRoot}/`), "utf8");
}

function normalizedWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

describe("Eve compatibility repository contract", () => {
  test("publishes a browser-safe compatibility policy subpath", () => {
    const corePackage = JSON.parse(
      repositoryFile("packages/core/package.json"),
    ) as { exports?: Record<string, string> };

    expect(corePackage.exports?.["./eve-compatibility"]).toBe(
      "./src/eve-compatibility.ts",
    );
  });

  test("describes a valid sliding compatibility window", () => {
    const { supportedLines, peerDependencyRange } = EVE_COMPATIBILITY_POLICY;
    const minorNumbers = supportedLines.map((line, index) => {
      const rangeMatch = /^0\.(\d+)\.x$/.exec(line.range);
      const verifiedMatch = /^0\.(\d+)\.(\d+)$/.exec(line.verifiedVersion);
      if (!rangeMatch || !verifiedMatch) {
        throw new Error(
          `Invalid Eve compatibility line: ${line.range} / ${line.verifiedVersion}`,
        );
      }

      const minor = Number(rangeMatch[1]);
      expect(Number(verifiedMatch[1]), line.range).toBe(minor);
      expect(line.dependencyName, line.range).toBe(
        index === supportedLines.length - 1
          ? "eve"
          : `eve-${line.range.replace(/\.x$/, "").replaceAll(".", "-")}`,
      );
      return minor;
    });

    expect(supportedLines).toHaveLength(3);
    expect(new Set(minorNumbers).size).toBe(3);
    expect(minorNumbers).toEqual(
      minorNumbers.map((_, index) => minorNumbers[0]! + index),
    );
    expect(peerDependencyRange).toBe(
      `>=0.${minorNumbers[0]}.0 <0.${minorNumbers.at(-1)! + 1}.0`,
    );
  });

  test("derives public compatibility values from the policy", async () => {
    const compatibility = await import("./eve-compatibility.js");
    const expectedRanges = EVE_COMPATIBILITY_POLICY.supportedLines.map(
      ({ range }) => range,
    );
    const expectedVersions = EVE_COMPATIBILITY_POLICY.supportedLines.map(
      ({ verifiedVersion }) => verifiedVersion,
    );

    expect(compatibility.SUPPORTED_EVE_VERSION_RANGES).toEqual(expectedRanges);
    expect(compatibility.VERIFIED_EVE_VERSIONS).toEqual(expectedVersions);
    expect(compatibility.LATEST_VERIFIED_EVE_VERSION).toBe(
      expectedVersions.at(-1),
    );
    expect(compatibility.SUPPORTED_EVE_VERSION_RANGE).toBe(
      `${expectedRanges.slice(0, -1).join(", ")}, or ${expectedRanges.at(-1)}`,
    );
  });

  test("makes the source scanner consume the compatibility policy", async () => {
    const compatibility = await import("./eve-compatibility.js");
    const source = await import("./source.js");

    expect(source.SUPPORTED_EVE_VERSION_RANGES).toBe(
      compatibility.SUPPORTED_EVE_VERSION_RANGES,
    );
  });

  test("makes the source scanner delegate compatibility decisions", async () => {
    const compatibility = await import("./eve-compatibility.js");
    const source = await import("./source.js");

    expect(source.isSupportedEveDependency).toBe(
      compatibility.isSupportedEveDependency,
    );
    expect(source.unsupportedEveVersionMessage).toBe(
      compatibility.unsupportedEveVersionMessage,
    );
    expect(source.createEveVersionInfo).toBe(
      compatibility.createEveVersionInfo,
    );
  });

  test("keeps package pins, fixtures, and active references aligned with policy", () => {
    const expectedDependencies = new Map<string, string>(
      EVE_COMPATIBILITY_POLICY.supportedLines.map((line) => [
        line.dependencyName,
        line.dependencyName === "eve"
          ? line.verifiedVersion
          : `npm:eve@${line.verifiedVersion}`,
      ]),
    );
    const packagePaths = globSync(
      ["apps/**/package.json", "packages/**/package.json", "infra/**/package.json"],
      {
        cwd: repositoryRoot,
        exclude: ["**/node_modules/**", "**/.next/**"],
      },
    );
    const checkedDependencies = new Set<string>();

    for (const packagePath of packagePaths) {
      const packageJson = JSON.parse(repositoryFile(packagePath)) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      for (const dependencies of [
        packageJson.dependencies,
        packageJson.devDependencies,
      ]) {
        const declaredEvePackages = Object.keys(dependencies ?? {}).filter(
          (dependencyName) =>
            dependencyName === "eve" || /^eve-\d+-\d+$/.test(dependencyName),
        );
        for (const dependencyName of declaredEvePackages) {
          expect(
            expectedDependencies.has(dependencyName),
            `${packagePath} declares an Eve package outside the compatibility policy: ${dependencyName}`,
          ).toBe(true);
        }
        for (const [dependencyName, expectedVersion] of expectedDependencies) {
          const actualVersion = dependencies?.[dependencyName];
          if (actualVersion === undefined) continue;
          checkedDependencies.add(dependencyName);
          expect(actualVersion, packagePath).toBe(expectedVersion);
        }
      }
      if (packageJson.peerDependencies?.eve !== undefined) {
        checkedDependencies.add("peer:eve");
        expect(packageJson.peerDependencies.eve, packagePath).toBe(
          EVE_COMPATIBILITY_POLICY.peerDependencyRange,
        );
      }
    }

    expect(checkedDependencies).toEqual(
      new Set([
        ...EVE_COMPATIBILITY_POLICY.supportedLines.map(
          ({ dependencyName }) => dependencyName,
        ),
        "peer:eve",
      ]),
    );

    const latestRange = SUPPORTED_EVE_VERSION_RANGES.at(-1)!;
    const quotedVerifiedVersions = VERIFIED_EVE_VERSIONS.map(
      (version) => `\`${version}\``,
    );
    const verifiedEnglish = `${quotedVerifiedVersions.slice(0, -1).join(", ")}, and ${quotedVerifiedVersions.at(-1)}`;
    const quotedVerifiedVersionsChinese = VERIFIED_EVE_VERSIONS.map(
      (version) => `\`${version}\``,
    );
    const verifiedChinese = `${quotedVerifiedVersionsChinese.slice(0, -1).join("、")} 与 ${quotedVerifiedVersionsChinese.at(-1)}`;
    const englishDocs = normalizedWhitespace(
      repositoryFile(
        "apps/docs/content/docs/en/reference/eve-compatibility.mdx",
      ),
    );
    const chineseDocs = normalizedWhitespace(
      repositoryFile(
        "apps/docs/content/docs/zh/reference/eve-compatibility.mdx",
      ),
    );

    expect(englishDocs).toContain(`verified at ${verifiedEnglish}`);
    expect(englishDocs).toContain(
      `marks only the latest supported line, \`${latestRange}\`, in green`,
    );
    expect(englishDocs).toContain(
      `refresh their lockfile and redeploy to receive \`${LATEST_VERIFIED_EVE_VERSION}\``,
    );
    expect(chineseDocs).toContain(`验证版本为 ${verifiedChinese}`);
    expect(chineseDocs).toContain(
      `UI 仅将最新支持线 \`${latestRange}\` 标为绿色`,
    );
    expect(chineseDocs).toContain(
      `才能实际获得 \`${LATEST_VERIFIED_EVE_VERSION}\``,
    );
  });

  test("keeps the active product and public documentation windows aligned", () => {
    const [oldest, middle, latest] = SUPPORTED_EVE_VERSION_RANGES;
    const exactMinors = SUPPORTED_EVE_VERSION_RANGES.map((range) =>
      range.replace(/\.x$/, ""),
    ).join("/");
    const spec = normalizedWhitespace(repositoryFile("docs/spec.md"));
    const englishDocs = normalizedWhitespace(
      repositoryFile(
        "apps/docs/content/docs/en/reference/eve-compatibility.mdx",
      ),
    );
    const chineseDocs = normalizedWhitespace(
      repositoryFile(
        "apps/docs/content/docs/zh/reference/eve-compatibility.mdx",
      ),
    );

    expect(spec).toContain(
      `当前窗口是 ${oldest}、${middle} 与 ${latest}。允许精确的 ${exactMinors} patch`,
    );
    expect(englishDocs).toContain(
      `supports \`${oldest}\`, \`${middle}\`, and \`${latest}\``,
    );
    expect(chineseDocs).toContain(
      `支持 \`${oldest}\`、\`${middle}\` 与 \`${latest}\``,
    );
  });
});
