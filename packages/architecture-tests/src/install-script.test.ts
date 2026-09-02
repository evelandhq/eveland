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
    const aptIndex = script.indexOf('base_missing="$base_missing docker.io docker-compose-v2"');
    const hardCheckIndex = script.indexOf("command -v git >/dev/null 2>&1 || fail");
    expect(aptIndex).toBeGreaterThan(-1);
    expect(hardCheckIndex).toBeGreaterThan(aptIndex);
    expect(script).toContain("systemctl enable --now docker");
  });

  test("Compose v2 is installed on the fresh host and hard-checked everywhere (docker.io alone lacks it)", () => {
    expect(script).toContain('base_missing="$base_missing docker.io docker-compose-v2"');
    expect(script).toContain("if ! docker compose version >/dev/null 2>&1; then");
    expect(script).toContain("docker compose (v2) is required");
  });

  test("the shims put the pinned interpreter's bin dir on PATH — a private Node is the only place pnpm lives", () => {
    const shim = script.slice(
      script.indexOf("write_shim() {"),
      script.indexOf("write_shim eveland "),
    );
    expect(shim).toContain('export PATH="$NODE_BIN_DIR:\\$PATH"');
    // PATH is exported before the exec line.
    expect(shim.indexOf("export PATH=")).toBeLessThan(shim.indexOf('exec "$EVELAND_NODE"'));
  });

  test("the default target is the newest exact vX.Y.Z tag, never a pre-release that sorts above it", () => {
    // `|| true` keeps the HEAD fallback reachable under pipefail when no
    // stable tag exists (a no-match grep would otherwise abort the script).
    expect(script).toContain("grep -E '^v[0-9]+\\.[0-9]+\\.[0-9]+$' | head -1 || true)\"");
  });

  test("a re-run repairs a dead pinned Node instead of forwarding to a shim that cannot start", () => {
    const repairIndex = script.indexOf('"$pinned_node" --version >/dev/null 2>&1');
    const forwardIndex = script.indexOf("forwarding to eveland-ctl update");
    expect(repairIndex).toBeGreaterThan(-1);
    expect(repairIndex).toBeLessThan(forwardIndex);
    expect(script).toContain('[ "$REPAIR_NODE" -eq 0 ] && [ -f "$ETC_DIR/install.json" ]');
    // The repair re-pins in place and never moves the checkout.
    expect(script).toContain("s|^EVELAND_NODE=.*|EVELAND_NODE=$EVELAND_NODE|");
    expect(script).toContain(
      'if [ "$REPAIR_NODE" -eq 1 ]; then\n  # A repair never moves the checkout',
    );
  });

  test("Compose is installed from the SAME package family as Docker; the families never mix", () => {
    // Ubuntu's docker-compose-v2 depends on docker.io, which conflicts with
    // Docker CE's containerd.io; CE gets docker-compose-plugin instead.
    const ce = script.indexOf("dpkg -s docker-ce >/dev/null 2>&1");
    expect(ce).toBeGreaterThan(-1);
    expect(script.slice(ce, ce + 200)).toContain(
      'base_missing="$base_missing docker-compose-plugin"',
    );
    const io = script.indexOf("dpkg -s docker.io >/dev/null 2>&1");
    expect(script.slice(io, io + 200)).toContain('base_missing="$base_missing docker-compose-v2"');
    // An unknown family fails with matching instructions rather than guessing.
    expect(script).toContain("its package family is unknown");
  });

  test("a Node repair never moves the checkout, even with EVELAND_VERSION: the version goes to update afterwards", () => {
    const repair = script.indexOf(
      'if [ "$REPAIR_NODE" -eq 1 ]; then\n  # A repair never moves the checkout',
    );
    const requested = script.indexOf(
      'elif [ -n "$REQUESTED_VERSION" ]; then\n  TARGET_REV="$REQUESTED_VERSION"',
    );
    expect(repair).toBeGreaterThan(-1);
    expect(repair).toBeLessThan(requested);
    // Dependencies are reinstalled only after the platform is stopped, and
    // the requested version is handed to update; the systemd form is
    // regenerated (new interpreter path in the units) via install --systemd.
    const stop = script.indexOf('"$BIN_DIR/eveland-ctl" stop || fail');
    const deps = script.indexOf("pnpm install --frozen-lockfile", stop);
    expect(stop).toBeGreaterThan(-1);
    expect(deps).toBeGreaterThan(stop);
    // A repair keeps the re-run contract: it ends by forwarding to update
    // (newest, or the pinned version), never by silently stopping short.
    expect(script).toContain(
      "Node repaired — forwarding to eveland-ctl update${REQUESTED_VERSION:+ --version $REQUESTED_VERSION}",
    );
    expect(script).not.toContain('note "Repair complete."');
    expect(script).toContain('"$BIN_DIR/eveland-ctl" install --systemd');
    // Service is restored BEFORE any version move: update's no-op and
    // refusal paths never start anything, so a repair that went straight to
    // update could leave the platform stopped.
    const restoreSystemd = script.indexOf('"$BIN_DIR/eveland-ctl" install --systemd');
    const restoreCtl = script.indexOf('"$BIN_DIR/eveland-ctl" start --no-prompt \\');
    const handToUpdate = script.indexOf("Node repaired — forwarding to eveland-ctl update");
    expect(restoreSystemd).toBeGreaterThan(-1);
    expect(restoreCtl).toBeGreaterThan(-1);
    expect(restoreSystemd).toBeLessThan(handToUpdate);
    expect(restoreCtl).toBeLessThan(handToUpdate);
    // --no-start after a repair says loudly that the platform stays stopped,
    // and names a requested version it therefore did NOT apply.
    expect(script).toContain("stays stopped (--no-start)");
    expect(script).toContain("was NOT applied (--no-start)");
    // A failed dependency install must not suggest starting on top of it.
    expect(script).toContain("do not start it");
    expect(script).not.toMatch(/pnpm install failed[^\n]*eveland-ctl start/);
  });

  test("a plain re-run honours --no-start instead of forwarding to update (which restarts)", () => {
    const noStart = script.indexOf("nothing to do with --no-start");
    const forward = script.indexOf("forwarding to eveland-ctl update");
    expect(noStart).toBeGreaterThan(-1);
    expect(noStart).toBeLessThan(forward);
  });

  test("the repin temp copy of the env file is born 0600, swapped in atomically, and cleaned by the trap", () => {
    expect(script).toContain(
      '( umask 077; sed "s|^EVELAND_NODE=.*|EVELAND_NODE=$EVELAND_NODE|" "$ETC_DIR/eveland.env" > "$REPIN_TMP" )',
    );
    expect(script).toContain('mv -f "$REPIN_TMP" "$ETC_DIR/eveland.env"');
    expect(script).toMatch(/trap 'status=\$\?; rm -f "\$REPIN_TMP";/);
    expect(script.indexOf('REPIN_TMP="$ETC_DIR/.eveland.env.repin"')).toBeLessThan(
      script.indexOf("trap 'status="),
    );
  });

  test("the installer verifies the EXACT pinned pnpm version, not merely that some pnpm runs", () => {
    expect(script).toContain('if [ "$(pnpm_version)" != "$PNPM_PIN" ]; then');
    expect(script).toContain('[ "$(pnpm_version)" = "$PNPM_PIN" ] || fail');
    expect(script).not.toContain("if ! command -v pnpm >/dev/null 2>&1; then");
  });

  test("the shims execute the two real bin entrypoints", () => {
    expect(script).toContain("packages/cli/src/bin.ts");
    expect(script).toContain("packages/ctl/src/bin.ts");
  });
});
