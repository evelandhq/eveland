// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { EveVersionInfo } from "@/lib/api";
import { TooltipProvider } from "@/components/ui/tooltip";

import { EveVersionStatus } from "./eve-version-status";

// "Current" means the newest supported line, not merely a supported one: the
// UI marks only that line healthy and shows every other supported line with an
// upgrade reminder, so this fixture has to move with the window.
const currentVersion = {
  version: "0.51.1",
  expected: "0.49.x, 0.50.x, or 0.51.x",
  supportedRanges: ["0.49.x", "0.50.x", "0.51.x"],
  supported: true,
  sourceRevisionId: "src_1",
} satisfies EveVersionInfo;

const unsupportedVersion = {
  ...currentVersion,
  version: "0.30.0",
  supported: false,
} satisfies EveVersionInfo;

describe("EveVersionStatus", () => {
  test("can present a healthy version without a redundant tooltip", () => {
    const { container } = render(
      <TooltipProvider>
        <EveVersionStatus
          eveVersion={currentVersion}
          showMessage={false}
          tooltipWhenCurrent={false}
        />
      </TooltipProvider>,
    );

    expect(screen.getByText("Eve 0.51.1")).toBeDefined();
    expect(container.querySelector('[data-slot="tooltip-trigger"]')).toBeNull();
  });

  test("keeps upgrade guidance available from an unhealthy version", () => {
    const { container } = render(
      <TooltipProvider>
        <EveVersionStatus
          eveVersion={unsupportedVersion}
          showMessage={false}
          tooltipWhenCurrent={false}
        />
      </TooltipProvider>,
    );

    expect(container.querySelector('[data-slot="tooltip-trigger"]')).not.toBeNull();
  });
});
