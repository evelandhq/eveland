// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { StatusBadge } from "./status-badge";

// Behavior, not source text: the badge's job is to render a readable label
// and to signal severity through its variant. The previous version of this
// file grepped status-badge.tsx for `completed: "secondary"`, which passed
// whenever that string existed and failed on any refactor that kept the
// behavior intact.
describe("StatusBadge", () => {
  test("renders a readable label for underscore statuses", () => {
    render(<StatusBadge status="waiting_approval" />);
    expect(screen.getByText("waiting approval")).toBeDefined();
  });

  test("renders 'none' when a project has no status yet", () => {
    render(<StatusBadge status={null} />);
    expect(screen.getByText("none")).toBeDefined();
  });

  const renderedVariant = (status: string, variant?: "outline") => {
    const { container } = render(<StatusBadge status={status} {...(variant ? { variant } : {})} />);
    return container.querySelector("[data-variant]")?.getAttribute("data-variant");
  };

  test.each(["failed", "delete_failed", "dispatch_unknown", "invalid"])(
    "marks %s as a failure the operator must notice",
    (status) => {
      expect(renderedVariant(status)).toBe("destructive");
    },
  );

  test("does not shout about a completed or running session", () => {
    expect(renderedVariant("completed")).not.toBe("destructive");
    expect(renderedVariant("running")).not.toBe("destructive");
  });

  test("falls back to a low-emphasis badge for an unknown status", () => {
    expect(renderedVariant("something_new_from_eve")).toBe("secondary");
  });

  test("an explicit variant overrides the status mapping", () => {
    expect(renderedVariant("failed", "outline")).toBe("outline");
  });
});
