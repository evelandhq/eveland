import { describe, expect, test, vi } from "vitest";
import { execa } from "execa";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSandboxVerifyArgs, buildSandboxVerifyScript, SANDBOX_VERIFY_SCRIPT_PATH, verifySandbox } from "./sandbox-verify.js";

vi.mock("execa", () => ({ execa: vi.fn(async () => ({ exitCode: 0, all: "SANDBOX VERIFY OK" })) }));

describe("buildSandboxVerifyScript", () => {
  test("exercises prewarm, create, run and shutdown against the vendored backend", () => {
    const script = buildSandboxVerifyScript();
    expect(script).toContain('from "./sandbox-bwrap/index.js"');
    expect(script).toContain("backend.prewarm(");
    expect(script).toContain("handle.session.run(");
    expect(script).toContain("handle.shutdown()");
    expect(script).toContain("SANDBOX VERIFY OK");
  });
});

describe("buildSandboxVerifyArgs", () => {
  test("runs under the deployment's hardening as the deployment user", () => {
    const args = buildSandboxVerifyArgs({ releaseDir: "/rel", user: "eveland-app", cacheDir: "/cache/p" });
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

  test("throws an actionable error naming both host prerequisites when the check fails", async () => {
    vi.mocked(execa).mockResolvedValueOnce({ exitCode: 1, all: "bwrap: setting up uid map: Permission denied" } as never);
    const releaseDir = await mkdtemp(path.join(os.tmpdir(), "eveland-verify-"));
    await expect(verifySandbox({ releaseDir, user: "eveland-app", cacheDir: "/cache/p" })).rejects.toThrow(/apparmor.*|\/workspace/is);
  });

  test("throws when the marker is missing even on exit 0", async () => {
    vi.mocked(execa).mockResolvedValueOnce({ exitCode: 0, all: "" } as never);
    const releaseDir = await mkdtemp(path.join(os.tmpdir(), "eveland-verify-"));
    await expect(verifySandbox({ releaseDir, user: "eveland-app", cacheDir: "/cache/p" })).rejects.toThrow();
  });
});
