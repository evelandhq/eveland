// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { EveVersionInfo } from "@/lib/api";
import { TooltipProvider } from "@/components/ui/tooltip";

import { EveVersionStatus } from "./eve-version-status";

const currentVersion = {
  version: "0.49.0",
  expected: "0.47.x or 0.49.x",
  supportedRanges: ["0.47.x", "0.49.x"],
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

    expect(screen.getByText("Eve 0.49.0")).toBeDefined();
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
