// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client-api", () => ({
  archiveDeployment: vi.fn(),
  drainDeployment: vi.fn(),
  promoteDeployment: vi.fn(),
  updateRouteTargets: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { DeploymentTrafficActions } from "./deployment-traffic-actions";

function renderActions(overrides: Partial<ComponentProps<typeof DeploymentTrafficActions>> = {}) {
  return render(
    <DeploymentTrafficActions
      projectId="proj_1"
      deploymentId="dep_1"
      productionDeploymentId="dep_production"
      stableRouteId="route_stable"
      status="running"
      routed={false}
      retentionProtected={false}
      {...overrides}
    />,
  );
}

function buttonNames(): string[] {
  return screen.queryAllByRole("button").map((button) => button.textContent ?? "");
}

describe("DeploymentTrafficActions", () => {
  test("an archived deployment offers no actions at all", () => {
    renderActions({ status: "archived" });

    // Every action here needs a Deployment that can still run or still be
    // retired. An archived row used to render three permanently greyed
    // buttons, which on a long history is most of the page.
    expect(buttonNames()).toEqual([]);
  });

  test("a stopped deployment offers only archive", () => {
    renderActions({ status: "stopped" });

    expect(buttonNames()).toEqual(["Archive"]);
  });

  test("a retention-protected deployment still shows archive, disabled", () => {
    renderActions({ status: "stopped", retentionProtected: true });

    // The row prints the protection reasons beside it, so the disabled button
    // is the thing those reasons explain -- worth keeping visible.
    const archive = screen.getByRole("button", { name: "Archive" }) as HTMLButtonElement;
    expect(archive.disabled).toBe(true);
  });

  test("withholds drain from a deployment that still receives routed traffic", () => {
    // The API refuses this with a 409 ("set this deployment route weight to
    // zero before draining"), so the button could only ever produce an error.
    renderActions({ status: "running", routed: true });

    expect(buttonNames()).not.toContain("Drain");
    expect(buttonNames()).toContain("Promote / rollback");
  });

  test("offers drain and traffic splits for a running preview", () => {
    renderActions({ status: "running", routed: false });

    expect(buttonNames()).toEqual(["Promote / rollback", "90/10", "50/50", "Drain", "Archive"]);
  });

  test("offers no split against itself once a deployment is production", () => {
    renderActions({ status: "running", productionDeploymentId: "dep_1", routed: true });

    expect(buttonNames()).toEqual(["Promote / rollback", "Archive"]);
  });
});
