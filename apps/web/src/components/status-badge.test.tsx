import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

describe("StatusBadge", () => {
  test("renders completed as a low-emphasis secondary badge", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./status-badge.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain('completed: "secondary"');
  });
});
