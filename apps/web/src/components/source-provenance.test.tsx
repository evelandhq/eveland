// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

vi.mock("@/components/date-time", () => ({
  DateTime: ({ value }: { value: string }) => <time dateTime={value}>{value}</time>,
}));

import { SourceProvenance } from "./source-provenance";

describe("SourceProvenance", () => {
  test("labels a CLI upload with its uploader, base commit, dirty state and time", () => {
    render(
      <SourceProvenance
        source={{
          kind: "zip",
          origin: "cli-upload",
          commitSha: null,
          baseCommitSha: "abcdef0123456789abcdef0123456789abcdef01",
          dirty: true,
          uploadedBy: { id: "user_a", name: "Ada", email: "ada@example.com" },
        }}
        recordedAt="2026-09-07T10:00:00.000Z"
      />,
    );

    expect(
      screen.getByText(
        /Uploaded from the CLI by Ada, based on abcdef012345, with uncommitted changes at/,
      ),
    ).toBeTruthy();
    expect(screen.getByText("2026-09-07T10:00:00.000Z")).toBeTruthy();
  });

  test("labels a git sync as its commit, without a time when none is given", () => {
    const { container } = render(
      <SourceProvenance
        source={{
          kind: "git",
          origin: "git-sync",
          commitSha: "0123456789abcdef0123456789abcdef01234567",
          baseCommitSha: null,
          dirty: null,
          uploadedBy: null,
        }}
      />,
    );

    expect(screen.getByText("Commit 0123456789ab")).toBeTruthy();
    expect(container.querySelector("time")).toBeNull();
  });
});
