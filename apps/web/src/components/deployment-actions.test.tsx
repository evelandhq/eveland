// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { SourceDrift } from "@evelandhq/core/contracts";

const refresh = vi.hoisted(() => vi.fn());
const syncSource = vi.hoisted(() => vi.fn(async () => ({})));
const enqueueBuildDeploy = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("@/lib/client-api", () => ({ syncSource, enqueueBuildDeploy }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { DeploymentActions } from "./deployment-actions";

const drifted: SourceDrift = {
  drifted: true,
  production: {
    revisionId: "src_hotfix",
    kind: "zip",
    origin: "cli-upload",
    commitSha: null,
    baseCommitSha: "abcdef0123456789abcdef0123456789abcdef01",
    dirty: true,
    uploadedBy: { id: "user_a", email: "ada@example.com", name: "Ada" },
    recordedAt: "2026-09-07T10:00:00.000Z",
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
      {...overrides}
    />,
  );
}

function openDialog() {
  fireEvent.click(screen.getByRole("button", { name: /Create deployment/ }));
}

function chooseSync() {
  fireEvent.click(screen.getByRole("button", { name: /Sync latest from Git first/ }));
}

describe("DeploymentActions", () => {
  test("syncing to production over a hotfix needs the replacement acknowledged", () => {
    renderActions({ sourceDrift: drifted });
    openDialog();
    chooseSync();

    const submit = screen.getByRole("button", { name: /Sync, deploy & promote/ });
    expect(submit).toHaveProperty("disabled", true);
    expect(
      screen.getByText(/Uploaded from the CLI by Ada, based on abcdef012345, with uncommitted/),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox"));
    expect(submit).toHaveProperty("disabled", false);
    fireEvent.click(submit);
    expect(syncSource).toHaveBeenCalledWith("proj_1", {
      deploy: true,
      promote: true,
      confirmDrift: true,
    });
  });

  test("a preview sync, or building the current revision, never asks", () => {
    renderActions({ sourceDrift: drifted });
    openDialog();
    chooseSync();
    fireEvent.click(screen.getByRole("button", { name: /Keep as preview/ }));
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Sync & create preview/ }));
    expect(syncSource).toHaveBeenLastCalledWith("proj_1", { deploy: true, promote: false });

    fireEvent.click(screen.getByRole("button", { name: /Current revision/ }));
    fireEvent.click(screen.getByRole("button", { name: /Promote to production/ }));
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  test("without drift the production sync submits at once", () => {
    renderActions({ sourceDrift: { drifted: false, production: null } });
    openDialog();
    chooseSync();
    expect(screen.queryByRole("checkbox")).toBeNull();
    const submit = screen.getByRole("button", { name: /Sync, deploy & promote/ });
    expect(submit).toHaveProperty("disabled", false);
    fireEvent.click(submit);
    expect(syncSource).toHaveBeenLastCalledWith("proj_1", { deploy: true, promote: true });
  });
});
