import { describe, expect, test } from "vitest";
import { formatCompactDateTime, formatDate, formatDateTime, formatTime } from "./date-time.js";

describe("compact date time", () => {
  test("shows only hours and minutes on the same local calendar day", () => {
    const now = new Date(2026, 6, 21, 21, 0);
    const scheduledAt = new Date(2026, 6, 21, 22, 10);

    expect(formatCompactDateTime(scheduledAt.toISOString(), now)).toBe("22:10");
  });

  test("includes month and day on a different local calendar day", () => {
    const now = new Date(2026, 6, 20, 21, 0);
    const scheduledAt = new Date(2026, 6, 21, 10, 31);

    expect(formatCompactDateTime(scheduledAt.toISOString(), now)).toBe("07-21 10:31");
  });

  test("uses the configured timezone for both the calendar day and clock time", () => {
    const now = new Date("2026-07-21T15:00:00.000Z");
    const scheduledAt = "2026-07-21T16:10:00.000Z";

    expect(formatCompactDateTime(scheduledAt, now, "Asia/Shanghai")).toBe("07-22 00:10");
    expect(formatCompactDateTime(scheduledAt, now, "America/Los_Angeles")).toBe("09:10");
  });
});

describe("configured date time", () => {
  const value = "2026-07-20T06:30:45.000Z";

  test("formats full timestamps in the requested IANA timezone", () => {
    expect(formatDateTime(value, "Asia/Shanghai")).toContain("14:30");
    expect(formatDateTime(value, "America/Los_Angeles")).toContain("23:30");
  });

  test("formats date-only and time-only values in the requested IANA timezone", () => {
    expect(formatDate(value, "America/Los_Angeles")).toContain("7/19/2026");
    expect(formatTime(value, "Asia/Shanghai")).toContain("14:30");
  });

  test("returns invalid input unchanged", () => {
    expect(formatDateTime("not-a-date", "UTC")).toBe("not-a-date");
  });
});
