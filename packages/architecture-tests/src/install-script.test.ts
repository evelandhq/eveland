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

  test("interactive handoffs reattach stdin to the terminal — curl|bash leaves stdin on the pipe", () => {
    // Both exec targets (start and the update forward) must carry </dev/tty
    // in the interactive branch, or eveland-ctl silently takes every default.
    expect(script).toMatch(/eveland-ctl" start <\/dev\/tty/);
    expect(script).toMatch(/--version "\$REQUESTED_VERSION"\} <\/dev\/tty/);
  });

  test("the install log is created 0600 before anything is teed into it", () => {
    const teeIndex = script.indexOf('tee -a "$LOG_FILE"');
    const chmodIndex = script.indexOf('chmod 600 "$LOG_FILE"');
    expect(chmodIndex).toBeGreaterThan(-1);
    expect(chmodIndex).toBeLessThan(teeIndex);
  });

  test("the curl front door is safe: explicit https, -f against error pages", () => {
    // The documented one-liner appears in the script's own header.
    expect(script).toContain("curl -fsSL https://eveland.ai/install.sh | bash");
  });

  test("a fresh Linux root host gets git/curl/docker from apt BEFORE the hard prerequisite checks", () => {
    // The one-line promise: `curl | bash` on a fresh Ubuntu must not exit
    // on "docker is required" — the front door installs the base toolchain
    // itself (only where it can: root + apt), then the hard checks run.
    const aptIndex = script.indexOf('base_missing="$base_missing docker.io"');
    const hardCheckIndex = script.indexOf("command -v git >/dev/null 2>&1 || fail");
    expect(aptIndex).toBeGreaterThan(-1);
    expect(hardCheckIndex).toBeGreaterThan(aptIndex);
    expect(script).toContain("systemctl enable --now docker");
  });

  test("the shims execute the two real bin entrypoints", () => {
    expect(script).toContain("packages/cli/src/bin.ts");
    expect(script).toContain("packages/ctl/src/bin.ts");
  });
});
