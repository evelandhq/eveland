import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("systemd integration smoke", () => {
  test("uses Eve projects for both the healthy and timeout-cleanup fixtures", async () => {
    const smokeScript = await readFile(new URL("./systemd-smoke.ts", import.meta.url), "utf8");

    expect(smokeScript.match(/dependencies: \{ eve: "0\.24\.6" \}/g)).toHaveLength(1);
    expect(smokeScript.match(/dependencies: \{ eve: "0\.25\.1" \}/g)).toHaveLength(1);
    expect(smokeScript).toContain("/eve/v1/health");
    expect(smokeScript).toContain('process.env.EVELAND_HEALTH_TIMEOUT_MS = "1"');
    expect(smokeScript).not.toContain("server.js");
    expect(smokeScript).not.toContain('start: "sleep 30"');
  });
});
