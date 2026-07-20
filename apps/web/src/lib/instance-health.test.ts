import { describe, expect, test } from "vitest";
import { formatBytes } from "./instance-health.js";

describe("instance health presentation", () => {
  test("formats capacity values for quick scanning", () => {
    expect(formatBytes(1_073_741_824)).toBe("1.0 GiB");
    expect(formatBytes(null)).toBe("Unavailable");
  });
});
