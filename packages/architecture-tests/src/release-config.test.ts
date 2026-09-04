import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { repoRoot } from "./scan-support.js";

function repositoryFile(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

// Release Please is the only thing that writes version numbers here, and it is
// driven entirely by these two files. Both failure modes it has are silent:
// a package path that no longer exists produces no release and no error, and a
// manifest that disagrees with a package.json makes the next bump start from
// the wrong number. Neither shows up in a build.

type ReleaseConfig = {
  "separate-pull-requests"?: boolean;
  packages: Record<
    string,
    { "release-type"?: string; component?: string; "include-component-in-tag"?: boolean }
  >;
};

const config = JSON.parse(repositoryFile("release-please-config.json")) as ReleaseConfig;
const manifest = JSON.parse(repositoryFile(".release-please-manifest.json")) as Record<
  string,
  string
>;

describe("release configuration", () => {
  test("every configured package has a manifest entry, and vice versa", () => {
    expect(Object.keys(manifest).sort()).toEqual(Object.keys(config.packages).sort());
  });

  test("each non-root package resolves to a real package.json at the declared version", () => {
    for (const [packagePath, options] of Object.entries(config.packages)) {
      if (packagePath === ".") continue;
      expect(options["release-type"], packagePath).toBe("node");
      const packageJson = JSON.parse(repositoryFile(`${packagePath}/package.json`)) as {
        name?: string;
        version?: string;
        private?: boolean;
      };
      // A private package would be versioned and tagged but never published.
      expect(packageJson.private, packagePath).not.toBe(true);
      expect(packageJson.version, packagePath).toBe(manifest[packagePath]);
      if (options.component !== undefined) {
        expect(options.component, packagePath).toBe(packageJson.name);
      }
    }
  });

  // The platform's own early tags include v0.5.0 through v0.9.0, and the
  // eveland package is inside that range today (0.7.0). An unprefixed
  // component tag would collide with a tag that already exists, so every
  // non-root component must carry its name in the tag.
  test("non-root components are tagged with their component name", () => {
    for (const [packagePath, options] of Object.entries(config.packages)) {
      if (packagePath === ".") continue;
      expect(options["include-component-in-tag"], packagePath).toBe(true);
    }
    expect(config.packages["."]?.["include-component-in-tag"]).toBe(false);
  });

  // A grouped release PR (the default once a second package is configured)
  // lives on the branch `release-please--branches--main` and carries no
  // component in its name. When such a PR turns out to release only the root
  // — the ordinary case, since the eveland package moves far less often —
  // Release Please reads it as a standalone release PR and refuses to tag it,
  // because the branch names no component while the root component resolves to
  // the package.json name. It logs one warning line and exits 0: the release PR
  // merges, the version lands in the manifest, and no tag or GitHub Release is
  // ever created. v0.51.1 was released by hand for exactly this reason.
  // One PR per component keeps the component in every branch name.
  test("components release through separate pull requests", () => {
    if (Object.keys(config.packages).length < 2) return;
    expect(config["separate-pull-requests"]).toBe(true);
  });
});
