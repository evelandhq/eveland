import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { parseUpdateCheck } from "@evelandhq/core/update-check";
import { applianceLayout } from "./home.ts";
import type { ExecCommand } from "./io.ts";
import { refreshUpdateCheck, updateCheckIsStale, updateChecksEnabled } from "./update-check.ts";

const CHANGELOG = [
  "# Changelog",
  "",
  "## [0.52.0](https://example.invalid/compare/v0.51.2...v0.52.0) (2026-09-10)",
  "",
  "### ⚠ BREAKING CHANGES",
  "",
  "* the gateway now refuses plaintext upstreams",
  "",
  "### Features",
  "",
  "* something else",
  "",
  "## [0.51.2](https://example.invalid/compare/v0.51.1...v0.51.2) (2026-09-01)",
  "",
  "### Bug Fixes",
  "",
  "* a fix",
  "",
].join("\n");

async function makeCheckout(options: {
  version?: string;
  revision?: string;
  tag?: string | null;
  tags?: string;
  fetchCode?: number | null;
  changelog?: string;
}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "eveland-check-home-"));
  const repo = await mkdtemp(path.join(os.tmpdir(), "eveland-check-repo-"));
  await writeFile(
    path.join(repo, "package.json"),
    JSON.stringify({ version: options.version ?? "0.51.2" }),
    "utf8",
  );
  const calls: string[][] = [];
  const execCommand: ExecCommand = async (argv) => {
    calls.push(argv);
    if (argv[1] === "rev-parse")
      return { code: 0, output: `${options.revision ?? "abc123abc123"}\n` };
    if (argv[1] === "describe") {
      const tag = options.tag === undefined ? "v0.51.2" : options.tag;
      return tag ? { code: 0, output: `${tag}\n` } : { code: 128, output: "no tag" };
    }
    if (argv[1] === "fetch") return { code: options.fetchCode ?? 0, output: "" };
    if (argv[1] === "tag") return { code: 0, output: options.tags ?? "v0.52.0\nv0.51.2\n" };
    if (argv[1] === "show") return { code: 0, output: options.changelog ?? CHANGELOG };
    return { code: 1, output: "" };
  };
  return { layout: applianceLayout(home), repo, execCommand, calls };
}

describe("refreshUpdateCheck", () => {
  test("publishes the newest stable tag and the breaking changes the move would cross", async () => {
    const harness = await makeCheckout({});
    const check = await refreshUpdateCheck({
      layout: harness.layout,
      repoRootDir: harness.repo,
      execCommand: harness.execCommand,
      checkEnabled: true,
      now: () => new Date("2026-09-11T00:00:00.000Z"),
    });
    expect(check).toMatchObject({
      version: "0.51.2",
      revision: "abc123abc123",
      channel: "stable",
      latestTag: "v0.52.0",
      breaking: ["0.52.0"],
      checkedAt: "2026-09-11T00:00:00.000Z",
    });
    // Written where every reader looks, and readable by the Dashboard's own uid.
    const onDisk = parseUpdateCheck(
      await readFile(path.join(harness.layout.runDir, "update-check.json"), "utf8"),
    );
    expect(onDisk).toEqual(check);
  });

  test("asks the same git remote `update` moves against, never an HTTP API", async () => {
    // The whole point: `status` cannot contradict `update` if both derive the
    // answer from the same fetch and the same tag list.
    const harness = await makeCheckout({});
    await refreshUpdateCheck({
      layout: harness.layout,
      repoRootDir: harness.repo,
      execCommand: harness.execCommand,
      checkEnabled: true,
    });
    expect(harness.calls).toContainEqual(["git", "fetch", "--tags", "--quiet"]);
    expect(harness.calls).toContainEqual(["git", "tag", "--list", "v*", "--sort=-v:refname"]);
    expect(harness.calls.every((argv) => argv[0] === "git")).toBe(true);
  });

  test("a pre-release tag is never the answer", async () => {
    const harness = await makeCheckout({ tags: "v0.53.0-rc.1\nv0.52.0\nv0.51.2\n" });
    const check = await refreshUpdateCheck({
      layout: harness.layout,
      repoRootDir: harness.repo,
      execCommand: harness.execCommand,
      checkEnabled: true,
    });
    expect(check?.latestTag).toBe("v0.52.0");
  });

  test("an edge checkout publishes its identity and asks nothing", async () => {
    const harness = await makeCheckout({ tag: null });
    const check = await refreshUpdateCheck({
      layout: harness.layout,
      repoRootDir: harness.repo,
      execCommand: harness.execCommand,
      checkEnabled: true,
    });
    expect(check).toMatchObject({ channel: "edge", latestTag: null, checkedAt: null });
    expect(harness.calls.some((argv) => argv[1] === "fetch")).toBe(false);
  });

  test("with the check off the identity is still published and the remote is not touched", async () => {
    // The off switch buys "this machine does not phone out". It must not also
    // cost the drift diagnosis, which needs no network at all.
    const harness = await makeCheckout({});
    const check = await refreshUpdateCheck({
      layout: harness.layout,
      repoRootDir: harness.repo,
      execCommand: harness.execCommand,
      checkEnabled: false,
    });
    expect(check).toMatchObject({ revision: "abc123abc123", latestTag: null, checkedAt: null });
    expect(harness.calls.some((argv) => argv[1] === "fetch")).toBe(false);
  });

  test("a failed fetch keeps the tags a previous one brought but withholds checkedAt", async () => {
    // Offline is not "no update exists": the local refs still hold whatever
    // the last successful fetch produced. Only the claim "the remote was
    // reached just now" is dropped.
    const harness = await makeCheckout({ fetchCode: 128 });
    const check = await refreshUpdateCheck({
      layout: harness.layout,
      repoRootDir: harness.repo,
      execCommand: harness.execCommand,
      checkEnabled: true,
    });
    expect(check).toMatchObject({ latestTag: "v0.52.0", checkedAt: null });
  });

  test("a checkout with no git revision publishes nothing at all", async () => {
    const harness = await makeCheckout({});
    const check = await refreshUpdateCheck({
      layout: harness.layout,
      repoRootDir: harness.repo,
      execCommand: async () => ({ code: 128, output: "not a git repository" }),
      checkEnabled: true,
    });
    expect(check).toBeNull();
  });
});

describe("updateChecksEnabled", () => {
  test("defaults on, and the first source that speaks wins", () => {
    expect(updateChecksEnabled({}, {})).toBe(true);
    expect(updateChecksEnabled({ EVELAND_UPDATE_CHECK: "off" }, {})).toBe(false);
    expect(updateChecksEnabled({}, { EVELAND_UPDATE_CHECK: "OFF" })).toBe(false);
    expect(
      updateChecksEnabled({ EVELAND_UPDATE_CHECK: "on" }, { EVELAND_UPDATE_CHECK: "off" }),
    ).toBe(true);
  });
});

describe("updateCheckIsStale", () => {
  const now = new Date("2026-09-11T00:00:00.000Z");
  const base = {
    version: "0.51.2",
    revision: "abc123abc123",
    channel: "stable" as const,
    tag: "v0.51.2",
    latestTag: null,
    breaking: [],
  };

  test("a check that never reached the remote is stale", () => {
    expect(updateCheckIsStale(null, now)).toBe(true);
    expect(updateCheckIsStale({ ...base, checkedAt: null }, now)).toBe(true);
    expect(updateCheckIsStale({ ...base, checkedAt: "not a date" }, now)).toBe(true);
  });

  test("a day is the boundary", () => {
    expect(updateCheckIsStale({ ...base, checkedAt: "2026-09-10T12:00:00.000Z" }, now)).toBe(false);
    expect(updateCheckIsStale({ ...base, checkedAt: "2026-09-09T12:00:00.000Z" }, now)).toBe(true);
  });
});
