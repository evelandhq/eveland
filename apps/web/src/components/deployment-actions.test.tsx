// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { HotfixDrift } from "@/lib/api";

const api = vi.hoisted(() => ({ enqueueBuildDeploy: vi.fn(), syncSource: vi.fn() }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client-api", () => api);
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/components/date-time", () => ({
  DateTime: ({ value }: { value: string }) => <time dateTime={value}>{value}</time>,
}));

import { DeploymentActions } from "./deployment-actions";

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

function renderActions(overrides: Partial<ComponentProps<typeof DeploymentActions>> = {}) {
  return render(
    <DeploymentActions
      projectId="proj_1"
      canSync
      canDeploy
      importJob={null}
      sourceRevisionId="src_current"
      sourceCommitSha={null}
      sourceRecordedAt={null}
      currentRevisionOrigin="cli-upload"
      hotfixDrift={null}
      {...overrides}
    />,
  );
}

function openDialog() {
  fireEvent.click(screen.getByRole("button", { name: /create deployment/i }));
  return screen.getByRole("dialog");
}

function choose(name: RegExp) {
  fireEvent.click(screen.getByRole("button", { name }));
}

function submitButton(): HTMLButtonElement {
  const submit = screen.getByRole("dialog").querySelector('button[type="submit"]');
  if (!(submit instanceof HTMLButtonElement)) throw new Error("dialog has no submit button");
  return submit;
}

describe("DeploymentActions", () => {
  beforeEach(() => {
    api.enqueueBuildDeploy.mockReset().mockResolvedValue({ id: "job_1" });
    api.syncSource.mockReset().mockResolvedValue({ id: "job_1" });
    refresh.mockClear();
  });

  test("promotes the current revision without ceremony when it is not replacing a hotfix", async () => {
    renderActions();
    openDialog();

    expect(screen.queryByText(/uploaded hotfix/i)).toBeNull();
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(api.enqueueBuildDeploy).toHaveBeenCalledExactlyOnceWith("proj_1", { promote: true }),
    );
  });

  test("rebuilding the hotfix itself while in drift is not a replacement", async () => {
    renderActions({ hotfixDrift: drift, currentRevisionOrigin: "cli-upload" });
    openDialog();

    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(submitButton().disabled).toBe(false);
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(api.enqueueBuildDeploy).toHaveBeenCalledExactlyOnceWith("proj_1", { promote: true }),
    );
  });

  test("syncing to production while in drift needs an explicit replace before it submits", async () => {
    renderActions({ hotfixDrift: drift });
    openDialog();
    choose(/sync latest from git first/i);

    // The warning names the hotfix, and the submit waits for the checkbox.
    expect(screen.getByText(/production runs an uploaded hotfix/i).textContent).toContain(
      "based on abc123def456, uncommitted changes, by michael at ",
    );
    const confirm = screen.getByRole("checkbox", { name: /replace the hotfix/i });
    const submit = submitButton();
    expect(submit.textContent).toContain("Sync, deploy & replace hotfix");
    expect(submit.disabled).toBe(true);

    fireEvent.click(confirm);
    expect(submitButton().disabled).toBe(false);
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(api.syncSource).toHaveBeenCalledExactlyOnceWith("proj_1", {
        deploy: true,
        promote: true,
        replaceHotfix: true,
      }),
    );
  });

  test("a preview sync while in drift replaces nothing and asks nothing", async () => {
    renderActions({ hotfixDrift: drift });
    openDialog();
    choose(/sync latest from git first/i);
    choose(/keep as preview/i);

    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText(/production runs an uploaded hotfix/i)).toBeNull();
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(api.syncSource).toHaveBeenCalledExactlyOnceWith("proj_1", {
        deploy: true,
        promote: false,
      }),
    );
  });

  test("promoting a current revision that came from git over a hotfix is guarded the same way", async () => {
    renderActions({ hotfixDrift: drift, currentRevisionOrigin: "git-sync" });
    openDialog();

    expect(submitButton().textContent).toContain("Build, deploy & replace hotfix");
    expect(submitButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /replace the hotfix/i }));
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(api.enqueueBuildDeploy).toHaveBeenCalledExactlyOnceWith("proj_1", {
        promote: true,
        replaceHotfix: true,
      }),
    );
  });
});
