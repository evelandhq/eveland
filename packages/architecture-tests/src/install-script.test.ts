import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

// The public installer (curl -fsSL https://eveland.ai/install.sh | bash) is
// served verbatim from apps/docs/public. These are its publication
// invariants: the checksum sidecar stays in lockstep, the script stays a
// dumb bounded front door (the smart logic lives in eveland-ctl), and it
// parses under bash.
const publicDir = path.resolve(import.meta.dirname, "../../../apps/docs/public");
const scriptPath = path.join(publicDir, "install.sh");
const script = readFileSync(scriptPath, "utf8");

describe("install.sh publication", () => {
  test("the sha256 sidecar matches the script byte-for-byte", () => {
    const sidecar = readFileSync(path.join(publicDir, "install.sh.sha256"), "utf8");
    const actual = createHash("sha256").update(readFileSync(scriptPath)).digest("hex");
    expect(sidecar.trim()).toBe(`${actual}  install.sh`);
  });

  test("the script parses under bash", async () => {
    await expect(promisify(execFile)("bash", ["-n", scriptPath])).resolves.toBeDefined();
  });

  test("stays a dumb script: bounded size, no bash-4-only features, hands off to eveland-ctl", () => {
    expect(script.split("\n").length).toBeLessThanOrEqual(500);
    // macOS ships bash 3.2: associative arrays and ${var,,} would break it.
    expect(script).not.toMatch(/declare -A/);
    expect(script).not.toMatch(/\$\{[A-Za-z_]+,,\}/);
    // The handoff and the re-run forward both go through eveland-ctl.
    expect(script).toContain('eveland-ctl" start');
    expect(script).toContain('eveland-ctl" update');
  });

  test("interaction goes through an actually-opened /dev/tty, never a bare existence test", () => {
    expect(script).toContain("exec 3</dev/tty");
    expect(script).not.toMatch(/\[ -[et] \/dev\/tty \]/);
  });

  test("the curl front door is safe: explicit https, -f against error pages", () => {
    // The documented one-liner appears in the script's own header.
    expect(script).toContain("curl -fsSL https://eveland.ai/install.sh | bash");
  });

  test("the shims execute the two real bin entrypoints", () => {
    expect(script).toContain("packages/cli/src/bin.ts");
    expect(script).toContain("packages/ctl/src/bin.ts");
  });
});
