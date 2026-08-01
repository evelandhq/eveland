import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("systemd integration smoke", () => {
  test("uses Eve projects for both the healthy and timeout-cleanup fixtures", async () => {
    const smokeScript = await readFile(new URL("./systemd-smoke.ts", import.meta.url), "utf8");

    expect(smokeScript.match(/dependencies: \{ eve: "0\.27\.13" \}/g)).toHaveLength(1);
    expect(smokeScript.match(/dependencies: \{ eve: "0\.29\.4" \}/g)).toHaveLength(1);
    expect(smokeScript).toContain("/eve/v1/health");
    expect(smokeScript).toContain('process.env.EVELAND_HEALTH_TIMEOUT_MS = "1"');
  });
});
