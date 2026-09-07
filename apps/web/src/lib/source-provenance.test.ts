import { describe, expect, test } from "vitest";
import { describeSourceProvenance } from "./source-provenance";

describe("describeSourceProvenance", () => {
  test("a git sync is the commit it is", () => {
    expect(
      describeSourceProvenance({
        kind: "git",
        origin: "git-sync",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        baseCommitSha: null,
        dirty: null,
        uploadedBy: null,
      }),
    ).toBe("Commit 0123456789ab");
    // A pre-provenance git revision still has its commit.
    expect(
      describeSourceProvenance({
        kind: "git",
        origin: null,
        commitSha: "fedcba9876543210fedcba9876543210fedcba98",
        baseCommitSha: null,
        dirty: null,
      }),
    ).toBe("Commit fedcba987654");
  });

  test("an upload says who sent it, what it was based on, and whether it was clean", () => {
    const base = "abcdef0123456789abcdef0123456789abcdef01";
    expect(
      describeSourceProvenance({
        kind: "zip",
        origin: "cli-upload",
        commitSha: null,
        baseCommitSha: base,
        dirty: true,
        uploadedBy: { name: "Ada", email: "ada@example.com" },
      }),
    ).toBe("Uploaded from the CLI by Ada, based on abcdef012345, with uncommitted changes");
    expect(
      describeSourceProvenance({
        kind: "zip",
        origin: "cli-upload",
        commitSha: null,
        baseCommitSha: base,
        dirty: false,
        uploadedBy: { name: "", email: "ada@example.com" },
      }),
    ).toBe("Uploaded from the CLI by ada@example.com, based on abcdef012345, clean");
    expect(
      describeSourceProvenance({
        kind: "zip",
        origin: "dashboard-upload",
        commitSha: null,
        baseCommitSha: null,
        dirty: null,
        uploadedBy: { name: "Grace", email: "grace@example.com" },
      }),
    ).toBe("Uploaded from the Dashboard by Grace");
  });

  test("a revision recorded before provenance existed degrades honestly", () => {
    expect(
      describeSourceProvenance({
        kind: "zip",
        origin: null,
        commitSha: null,
        baseCommitSha: null,
        dirty: null,
        uploadedBy: null,
      }),
    ).toBe("Uploaded");
    // The current-revision shape carries only an uploader id: no name to show.
    expect(
      describeSourceProvenance({
        kind: "zip",
        origin: "cli-upload",
        commitSha: null,
        baseCommitSha: "1234567890123456789012345678901234567890",
        dirty: false,
        uploadedBy: "user_a",
      }),
    ).toBe("Uploaded from the CLI, based on 123456789012, clean");
  });
});
