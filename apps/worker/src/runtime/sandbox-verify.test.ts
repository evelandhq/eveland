import { describe, expect, test, vi } from "vitest";
import { execa } from "execa";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildSandboxVerifyArgs,
  buildSandboxVerifyScript,
  SANDBOX_VERIFY_SCRIPT_PATH,
  verifySandbox,
} from "./sandbox-verify.js";
import { SANDBOX_TOOLCHAIN_COMMANDS } from "./sandbox-toolchain.js";

const execFileAsync = promisify(execFile);

vi.mock("execa", () => ({ execa: vi.fn(async () => ({ exitCode: 0, all: "SANDBOX VERIFY OK" })) }));

describe("buildSandboxVerifyScript", () => {
  test("drives the vendored provider through prepare, start, spawn, stop and session end", () => {
    const script = buildSandboxVerifyScript();
    expect(script).toContain('from "./sandbox-bwrap/index.js"');
    expect(script).toContain("createBwrapSandboxProviderDefinition()");
    expect(script).toContain("environment.prepare(");
    expect(script).toContain("environment.start(");
    expect(script).toContain("connection.writeFiles(");
    expect(script).toContain("connection.spawn(");
    expect(script).toContain("const message: string");
    expect(script).toContain("node eveland-verify.ts");
    expect(script).toContain("connection.stop()");
    expect(script).toContain("environment.onSessionEnd(");
    expect(script).toContain("SANDBOX VERIFY OK");
  });

  test("checks every command in the platform toolchain and Eve's real grep paths", () => {
    const script = buildSandboxVerifyScript();
    for (const command of SANDBOX_TOOLCHAIN_COMMANDS) {
      expect(script, command).toContain(command);
    }
    expect(script).toContain('command -v "$command"');
    expect(script).toContain("rg -n --color=never -i -m 1 -- 'eveland-typescript-ok' .");
    expect(script).toContain(
      "grep -r -n --color=never --exclude-dir=.git -i -E -m 1 -- 'eveland-typescript-ok' .",
    );
    expect(script).toContain("missing sandbox commands:");
  });

  test("never calls process.exit -- stdout/stderr are pipes here (execa + systemd-run --pipe), so exit() can truncate a large diagnostic", () => {
    const script = buildSandboxVerifyScript();
    expect(script).not.toContain("process.exit(");
    expect(script).toContain("process.exitCode = 1");
  });

  test("wraps the whole body in a top-level catch that routes into the same structured-failure path as the named checks", () => {
    const script = buildSandboxVerifyScript();
    // "sandbox self-check failed:" must be built in exactly one place (whatever
    // throws, prewarm/create/shutdown or an explicit named check, must print
    // the identical structured prefix) -- so assert there's a single shared
    // formatter and that both the catch block and the exit-code assignment
    // route through it, rather than duplicating the prefix ad hoc per branch.
    expect(script).toContain("sandbox self-check failed:");
    const catchIndex = script.indexOf("} catch");
    expect(catchIndex).toBeGreaterThan(-1);
    // The catch block must call the same failure path the named checks use,
    // not print a bare error/stack directly.
    expect(script.slice(catchIndex)).toMatch(/}\s*catch[^{]*\{[^}]*fail\(/);
  });

  test("still cleans up the temp appRoot in a finally block", () => {
    const script = buildSandboxVerifyScript();
    expect(script).toContain("finally");
    expect(script).toContain("rm(appRoot");
  });
});

describe("buildSandboxVerifyScript, executed end-to-end against a stub provider", () => {
  test("prints one structured diagnostic to stderr and exits non-zero when start() throws", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eveland-verify-e2e-"));
    // Mirrors the real layout: the verify script and the vendored provider are
    // siblings under `.eveland/` in a release dir (see VENDORED_PROVIDER_DIR).
    const backendDir = path.join(root, "sandbox-bwrap");
    await mkdir(backendDir, { recursive: true });
    await writeFile(
      path.join(backendDir, "index.js"),
      [
        "export function createBwrapSandboxProviderDefinition() {",
        "  return {",
        "    environment: () => ({",
        '      prepare: async () => ({ version: 1, templatePath: "/t" }),',
        '      start: async () => { throw new Error("bwrap: setting up uid map: Permission denied"); },',
        "    }),",
        "  };",
        "}",
        "",
      ].join("\n"),
    );
    const scriptPath = path.join(root, "verify-sandbox.mjs");
    await writeFile(scriptPath, buildSandboxVerifyScript(), "utf8");
    const cacheRoot = path.join(root, "cache");
    await mkdir(cacheRoot, { recursive: true });

    await expect(
      execFileAsync("node", [scriptPath], {
        env: { ...process.env, EVELAND_SANDBOX_CACHE_DIR: cacheRoot },
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("sandbox self-check failed:"),
    });
  });

  test("prints SANDBOX VERIFY OK and exits zero when the provider succeeds", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eveland-verify-e2e-"));
    const backendDir = path.join(root, "sandbox-bwrap");
    await mkdir(backendDir, { recursive: true });
    await writeFile(
      path.join(backendDir, "index.js"),
      [
        "const stream = (text) => new Response(text).body;",
        "let ended = false;",
        "export function createBwrapSandboxProviderDefinition() {",
        "  return {",
        "    environment: () => ({",
        '      prepare: async () => ({ version: 1, templatePath: "/t" }),',
        "      start: async () => ({",
        '        state: { version: 1, sessionKey: "k", networkPolicy: "allow-all" },',
        "        connection: {",
        "          writeFiles: async () => {},",
        "          spawn: async () => ({",
        '            stdout: stream("eveland-typescript-ok\\n"),',
        '            stderr: stream(""),',
        "            wait: async () => ({ exitCode: 0 }),",
        "          }),",
        "          stop: async () => {},",
        "        },",
        "      }),",
        "      onSessionEnd: async () => { ended = true; },",
        "    }),",
        "  };",
        "}",
        'process.on("beforeExit", () => { if (!ended) process.exitCode = 3; });',
        "",
      ].join("\n"),
    );
    const scriptPath = path.join(root, "verify-sandbox.mjs");
    await writeFile(scriptPath, buildSandboxVerifyScript(), "utf8");
    const cacheRoot = path.join(root, "cache");
    await mkdir(cacheRoot, { recursive: true });

    const { stdout } = await execFileAsync("node", [scriptPath], {
      env: { ...process.env, EVELAND_SANDBOX_CACHE_DIR: cacheRoot },
    });
    expect(stdout).toContain("SANDBOX VERIFY OK");
  });
});

describe("buildSandboxVerifyArgs", () => {
  test("runs under the deployment's hardening as the deployment user", () => {
    const args = buildSandboxVerifyArgs({
      releaseDir: "/rel",
      user: "eveland-app",
      cacheDir: "/cache/p",
    });
    expect(args).toContain("--property=User=eveland-app");
    expect(args).toContain("--property=NoNewPrivileges=yes");
    expect(args).toContain("--property=ProtectSystem=strict");
    expect(args).toContain("--property=ReadWritePaths=/cache/p");
    expect(args).toContain("--setenv=EVELAND_SANDBOX_CACHE_DIR=/cache/p");
    expect(args.at(-1)).toBe(path.join("/rel", SANDBOX_VERIFY_SCRIPT_PATH));
  });
});

describe("verifySandbox", () => {
  test("writes the script and resolves when the check prints its marker", async () => {
    vi.mocked(execa).mockClear();
    const releaseDir = await mkdtemp(path.join(os.tmpdir(), "eveland-verify-"));
    await verifySandbox({ releaseDir, user: "eveland-app", cacheDir: "/cache/p" });
    const script = await readFile(path.join(releaseDir, SANDBOX_VERIFY_SCRIPT_PATH), "utf8");
    expect(script).toContain("SANDBOX VERIFY OK");
    expect(vi.mocked(execa).mock.calls[0]![0]).toBe("systemd-run");
  });

  test("throws an actionable error naming the sandbox and toolchain host prerequisites when the check fails", async () => {
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 1,
      all: "bwrap: setting up uid map: Permission denied",
    } as never);
    const releaseDir = await mkdtemp(path.join(os.tmpdir(), "eveland-verify-"));
    await expect(
      verifySandbox({ releaseDir, user: "eveland-app", cacheDir: "/cache/p" }),
    ).rejects.toThrow(/sandbox toolchain/is);
  });

  test("throws when the marker is missing even on exit 0", async () => {
    vi.mocked(execa).mockResolvedValueOnce({ exitCode: 0, all: "" } as never);
    const releaseDir = await mkdtemp(path.join(os.tmpdir(), "eveland-verify-"));
    await expect(
      verifySandbox({ releaseDir, user: "eveland-app", cacheDir: "/cache/p" }),
    ).rejects.toThrow();
  });
});
