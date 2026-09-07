import { describe, expect, test } from "vitest";
import type { ReleaseSourceProvenance } from "./contracts.js";
import { deriveSourceDrift } from "./source-drift.js";

const synced: ReleaseSourceProvenance = {
  revisionId: "src_synced",
  kind: "git",
  origin: "git-sync",
  commitSha: "a".repeat(40),
  baseCommitSha: null,
  dirty: null,
  uploadedBy: null,
  recordedAt: "2026-09-07T00:00:00.000Z",
};
const uploaded: ReleaseSourceProvenance = {
  ...synced,
  revisionId: "src_uploaded",
  kind: "zip",
  origin: "cli-upload",
  commitSha: null,
  baseCommitSha: "a".repeat(40),
  dirty: true,
  uploadedBy: { id: "user_a", email: "a@example.com", name: "Ada" },
};

describe("deriveSourceDrift", () => {
  test("a git project whose production is an upload has drifted", () => {
    expect(deriveSourceDrift("git", uploaded)).toEqual({ drifted: true, production: uploaded });
  });

  test("a synced commit in production, or no production, is not drift", () => {
    expect(deriveSourceDrift("git", synced)).toEqual({ drifted: false, production: synced });
    expect(deriveSourceDrift("git", null)).toEqual({ drifted: false, production: null });
  });

  test("a zip project has no repository to drift from", () => {
    expect(deriveSourceDrift("zip", uploaded)).toEqual({ drifted: false, production: uploaded });
  });

  test("a legacy upload revision without an origin still counts by its kind", () => {
    const legacy = {
      ...uploaded,
      origin: null,
      baseCommitSha: null,
      dirty: null,
      uploadedBy: null,
    };
    expect(deriveSourceDrift("git", legacy).drifted).toBe(true);
  });
});
