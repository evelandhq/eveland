import { describe, expect, test } from "vitest";
import { formatCompactDateTime } from "./date-time.js";

describe("compact date time", () => {
  test("shows only hours and minutes on the same local calendar day", () => {
    const now = new Date(2026, 6, 21, 21, 0);
    const scheduledAt = new Date(2026, 6, 21, 22, 10);

    expect(formatCompactDateTime(scheduledAt.toISOString(), now)).toBe("22:10");
  });

  test("includes month and day on a different local calendar day", () => {
    const now = new Date(2026, 6, 20, 21, 0);
    const scheduledAt = new Date(2026, 6, 21, 10, 31);

    expect(formatCompactDateTime(scheduledAt.toISOString(), now)).toBe(
      "07-21 10:31",
    );
  });
});
