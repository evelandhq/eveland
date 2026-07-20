import { describe, expect, test } from "vitest";
import {
  capacityTimelineScale,
  formatBytes,
  formatCapacityTimelineTick,
  formatCapacityTooltipTimestamp,
} from "./instance-health.js";

describe("instance health presentation", () => {
  test("formats capacity values for quick scanning", () => {
    expect(formatBytes(1_073_741_824)).toBe("1.0 GiB");
    expect(formatBytes(null)).toBe("Unavailable");
  });

  test("formats deterministic UTC timestamps for each health history range", () => {
    const observedAt = "2026-07-20T06:30:00.000Z";

    expect(formatCapacityTimelineTick(observedAt, 24)).toBe("06:30");
    expect(formatCapacityTimelineTick(observedAt, 168)).toBe("Jul 20 06:30");
  });

  test("aligns a 24-hour chart domain and ticks to half-hour boundaries", () => {
    const scale = capacityTimelineScale([
      "2026-07-20T01:42:00.000Z",
      "2026-07-20T04:16:00.000Z",
    ], 24);

    expect(scale).toEqual({
      domain: [
        Date.parse("2026-07-20T01:30:00.000Z"),
        Date.parse("2026-07-20T04:30:00.000Z"),
      ],
      ticks: [
        "2026-07-20T01:30:00.000Z",
        "2026-07-20T02:00:00.000Z",
        "2026-07-20T02:30:00.000Z",
        "2026-07-20T03:00:00.000Z",
        "2026-07-20T03:30:00.000Z",
        "2026-07-20T04:00:00.000Z",
        "2026-07-20T04:30:00.000Z",
      ].map(Date.parse),
    });
  });

  test("formats a full timestamp for the chart tooltip", () => {
    expect(formatCapacityTooltipTimestamp("2026-07-20T06:30:45.000Z"))
      .toBe("2026-07-20 06:30:45 UTC");
  });
});
