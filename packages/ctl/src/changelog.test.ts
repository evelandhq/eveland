import { describe, expect, test } from "vitest";
import {
  breakingChangesBetween,
  extractBreakingChanges,
  parseReleaseSections,
} from "./changelog.ts";

const CHANGELOG = `# Changelog

Intro text.

## [0.49.0](https://example.com/compare/v0.48.0...v0.49.0) (2026-09-02)

### ⚠ BREAKING CHANGES

* **ctl:** something moved ([#500](https://example.com/500))

### Features

* a feature

## [0.48.0](https://example.com/compare/v0.47.0...v0.48.0) (2026-08-31)

### Features

* only features here

## [0.47.0](https://example.com/compare/v0.46.0...v0.47.0) (2026-08-31)

### ⚠ BREAKING CHANGES

* **front-door:** two verbatim rules ([#428](https://example.com/428))
* **front-door:** identity into /api ([#426](https://example.com/426))

### Features

* stuff
`;

describe("parseReleaseSections", () => {
  test("finds every release, newest first, with its body", () => {
    const sections = parseReleaseSections(CHANGELOG);
    expect(sections.map((section) => section.version)).toEqual(["0.49.0", "0.48.0", "0.47.0"]);
    expect(sections[1]!.body).toContain("only features here");
    expect(sections[1]!.body).not.toContain("something moved");
  });
});

describe("extractBreakingChanges", () => {
  test("returns the breaking block and null when there is none", () => {
    const sections = parseReleaseSections(CHANGELOG);
    expect(extractBreakingChanges(sections[0]!.body)).toContain("something moved");
    expect(extractBreakingChanges(sections[0]!.body)).not.toContain("a feature");
    expect(extractBreakingChanges(sections[1]!.body)).toBeNull();
  });
});

describe("breakingChangesBetween", () => {
  test("collects every break the upgrade crosses, oldest first, excluding the current version", () => {
    const breaking = breakingChangesBetween(CHANGELOG, "0.46.0", "0.49.0");
    expect(breaking.map((entry) => entry.version)).toEqual(["0.47.0", "0.49.0"]);
  });

  test("a release already running is not re-surfaced", () => {
    const breaking = breakingChangesBetween(CHANGELOG, "0.47.0", "0.49.0");
    expect(breaking.map((entry) => entry.version)).toEqual(["0.49.0"]);
  });

  test("an upgrade crossing only clean releases reports nothing", () => {
    expect(breakingChangesBetween(CHANGELOG, "0.47.0", "0.48.0")).toEqual([]);
  });
});
