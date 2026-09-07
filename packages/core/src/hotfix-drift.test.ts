import { describe, expect, test } from "vitest";
import type { HotfixDrift } from "./contracts.js";
import { describeHotfixDrift, hotfixDriftFacts, hotfixDriftWarning } from "./hotfix-drift.js";

function drift(overrides: Partial<HotfixDrift["source"]> = {}): HotfixDrift {
  return {
    deploymentId: "dep_hotfix",
    deploymentKey: "hotfix01",
    releaseId: "rel_hotfix",
    source: {
      revisionId: "src_hotfix",
      kind: "zip",
      origin: "cli-upload",
      commitSha: null,
      baseCommitSha: "abc123def4567890abc123def4567890abc123de",
      dirty: true,
      uploadedBy: { id: "user_m", email: "michael@example.com", name: "michael" },
      recordedAt: "2026-09-07T14:02:31.000Z",
      ...overrides,
    },
  };
}

describe("hotfix drift wording", () => {
  test("names the base commit, tree state, uploader and time", () => {
    expect(hotfixDriftFacts(drift())).toEqual([
      "based on abc123def456",
      "uncommitted changes",
      "by michael",
    ]);
    expect(describeHotfixDrift(drift())).toBe(
      "an uploaded hotfix (based on abc123def456, uncommitted changes, by michael at 2026-09-07 14:02 UTC)",
    );
    expect(hotfixDriftWarning(drift())).toBe(
      "Production runs an uploaded hotfix (based on abc123def456, uncommitted changes, by michael at 2026-09-07 14:02 UTC); the repository does not contain it. Commit it before the next production sync.",
    );
  });

  test("degrades when the upload carried no base commit or uploader", () => {
    expect(hotfixDriftFacts(drift({ baseCommitSha: null, dirty: null, uploadedBy: null }))).toEqual(
      ["not based on any known commit"],
    );
    expect(hotfixDriftFacts(drift({ dirty: false }))).toContain("clean tree");
    // A user without a display name is named by email.
    expect(
      hotfixDriftFacts(drift({ uploadedBy: { id: "u", email: "ops@example.com", name: "" } })),
    ).toContain("by ops@example.com");
  });

  test("lets a surface format the time for its own viewer", () => {
    expect(describeHotfixDrift(drift(), { formatTime: () => "14:02" })).toBe(
      "an uploaded hotfix (based on abc123def456, uncommitted changes, by michael at 14:02)",
    );
  });
});
