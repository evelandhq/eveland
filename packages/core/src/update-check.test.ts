import { describe, expect, test } from "vitest";
import { availableUpdate, parseUpdateCheck, revisionDrift } from "@evelandhq/core/update-check";

const CHECK = {
  checkedAt: "2026-09-11T00:00:00.000Z",
  version: "0.51.2",
  revision: "abc123abc123",
  channel: "stable" as const,
  tag: "v0.51.2",
  latestTag: null as string | null,
  breaking: [] as string[],
};

describe("availableUpdate", () => {
  test("announces a strictly newer release and the breaks it crosses", () => {
    expect(availableUpdate({ ...CHECK, latestTag: "v0.52.0", breaking: ["0.52.0"] })).toEqual({
      tag: "v0.52.0",
      version: "0.52.0",
      breaking: ["0.52.0"],
    });
  });

  test("says nothing when it does not know, and nothing when there is nothing to say", () => {
    // Every "we cannot tell" case collapses into the same silence as "you are
    // current": a reader may only ever make the positive claim.
    expect(availableUpdate(null)).toBeNull();
    expect(availableUpdate(CHECK)).toBeNull();
    expect(availableUpdate({ ...CHECK, latestTag: "v0.51.2" })).toBeNull();
    expect(availableUpdate({ ...CHECK, latestTag: "v0.51.1" })).toBeNull();
    expect(availableUpdate({ ...CHECK, latestTag: "main" })).toBeNull();
    expect(availableUpdate({ ...CHECK, version: "nightly", latestTag: "v0.52.0" })).toBeNull();
  });

  test("compares numerically, not lexically", () => {
    expect(availableUpdate({ ...CHECK, version: "0.9.0", latestTag: "v0.10.0" })).toMatchObject({
      tag: "v0.10.0",
    });
    expect(availableUpdate({ ...CHECK, version: "0.10.0", latestTag: "v0.9.0" })).toBeNull();
  });
});

describe("revisionDrift", () => {
  test("reports a process running a revision the checkout no longer holds", () => {
    expect(revisionDrift({ ...CHECK, revision: "ffffffffffff" }, "abc123abc123")).toEqual({
      checkout: "ffffffffffff",
      running: "abc123abc123",
    });
  });

  test("stays silent when either side is unknown or they agree", () => {
    expect(revisionDrift(CHECK, "abc123abc123")).toBeNull();
    expect(revisionDrift(CHECK, undefined)).toBeNull();
    // A development checkout reports "unknown"; that is not drift.
    expect(revisionDrift(CHECK, "unknown")).toBeNull();
    expect(revisionDrift(null, "abc123abc123")).toBeNull();
  });
});

describe("parseUpdateCheck", () => {
  test("round-trips a published check", () => {
    expect(parseUpdateCheck(JSON.stringify(CHECK))).toEqual(CHECK);
  });

  test("a shape it does not recognise is 'no check', never an exception", () => {
    // Read by pages that must render whatever state the disk is in.
    expect(parseUpdateCheck("not json")).toBeNull();
    expect(parseUpdateCheck("null")).toBeNull();
    expect(parseUpdateCheck("[]")).toBeNull();
    expect(parseUpdateCheck(JSON.stringify({ ...CHECK, channel: "nonsense" }))).toBeNull();
    expect(parseUpdateCheck(JSON.stringify({ ...CHECK, version: 3 }))).toBeNull();
  });

  test("tolerates missing optional fields written by an older ctl", () => {
    expect(
      parseUpdateCheck(
        JSON.stringify({ version: "0.51.2", revision: "abc123abc123", channel: "stable" }),
      ),
    ).toEqual({ ...CHECK, checkedAt: null, tag: null, latestTag: null, breaking: [] });
  });
});
