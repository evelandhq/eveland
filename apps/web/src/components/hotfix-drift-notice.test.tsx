// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { HotfixDrift } from "@/lib/api";

vi.mock("@/components/date-time", () => ({
  DateTime: ({ value }: { value: string }) => <time dateTime={value}>{value}</time>,
}));

import { HotfixDriftNotice } from "./hotfix-drift-notice";

const drift: HotfixDrift = {
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
    recordedAt: "2026-09-07T14:02:00.000Z",
  },
};

describe("HotfixDriftNotice", () => {
  test("renders nothing while production runs a git revision", () => {
    const { container } = render(<HotfixDriftNotice projectId="proj_1" drift={null} />);
    expect(container.innerHTML).toBe("");
  });

  test("names the hotfix, who uploaded it and what to do about it", () => {
    render(<HotfixDriftNotice projectId="proj_1" drift={drift} />);

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Production runs an uploaded hotfix");
    expect(alert.textContent).toContain(
      "based on abc123def456, uncommitted changes, by michael at ",
    );
    expect(alert.textContent).toContain("the repository does not contain it.");
    expect(alert.textContent).toContain("Commit it before the next production sync.");
    expect(screen.getByText("2026-09-07T14:02:00.000Z")).toBeTruthy();
    expect(screen.getByRole("link", { name: /deployments/i }).getAttribute("href")).toBe(
      "/projects/proj_1/deployments",
    );
  });
});
