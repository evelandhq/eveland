import { describe, expect, test } from "vitest";
import { formatBytes, trendPoints } from "./instance-health.js";

describe("instance health presentation", () => {
  test("normalizes a metric series into stable SVG points", () => {
    expect(trendPoints([20, 50, 80], 120, 40)).toBe("0,40 60,20 120,0");
  });

  test("renders a flat series without dividing by zero", () => {
    expect(trendPoints([50, 50], 100, 30)).toBe("0,15 100,15");
  });

  test("returns no path for insufficient history", () => {
    expect(trendPoints([50], 100, 30)).toBe("");
  });

  test("formats capacity values for quick scanning", () => {
    expect(formatBytes(1_073_741_824)).toBe("1.0 GiB");
    expect(formatBytes(null)).toBe("Unavailable");
  });
});
