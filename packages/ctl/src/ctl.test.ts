import { describe, expect, test } from "vitest";
import { runCtl, unknownCommandMessage, type CtlIo } from "./ctl.ts";

function makeIo(extraEnv: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CtlIo = {
    env: { ...extraEnv },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  };
  return { io, out, err };
}

describe("runCtl dispatch", () => {
  test("bare invocation prints help and exits 1, explicit help exits 0", async () => {
    const bare = makeIo();
    expect(await runCtl([], bare.io)).toBe(1);
    expect(bare.out.join("\n")).toContain("Usage: eveland-ctl <command>");

    const explicit = makeIo();
    expect(await runCtl(["help"], explicit.io)).toBe(0);
  });

  test("help lists the operator commands and hides the internal supervisor entry", async () => {
    const { io, out } = makeIo();
    await runCtl(["help"], io);
    const help = out.join("\n");
    for (const name of ["start", "stop", "restart", "status", "logs", "doctor"]) {
      expect(help).toContain(`  ${name}`);
    }
    expect(help).not.toContain("_supervise");
  });

  test("--version reports the root manifest's product version", async () => {
    const { io, out } = makeIo();
    expect(await runCtl(["--version"], io)).toBe(0);
    expect(out[0]).toMatch(/^eveland-ctl \d+\.\d+\.\d+/);
  });

  test("a thrown command error becomes one stderr line and exit 1, not a stack trace", async () => {
    const { io, err } = makeIo();
    // An unsupported platform makes appliance-root resolution throw.
    const code = await runCtl(["status"], { ...io, platform: "win32" as NodeJS.Platform });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("Unsupported platform");
    expect(err.join("\n")).not.toContain("    at ");
  });
});

describe("unknown command hints", () => {
  test("an eveland verb points across binaries", () => {
    expect(unknownCommandMessage("deploy")).toBe(
      "'deploy' talks to a platform as an agent author — try `eveland deploy`.",
    );
  });

  test("a near-miss of a ctl verb suggests the ctl spelling", () => {
    expect(unknownCommandMessage("statu")).toContain("`eveland-ctl status`");
  });

  test("a near-miss of an eveland verb suggests the other binary", () => {
    expect(unknownCommandMessage("deply")).toContain("`eveland deploy`");
  });

  test("update and install are real commands now, listed in help", async () => {
    const { io, out } = makeIo();
    await runCtl(["help"], io);
    const help = out.join("\n");
    expect(help).toContain("  update");
    expect(help).toContain("  install");
  });

  test("garbage gets the generic message", () => {
    expect(unknownCommandMessage("frobnicate")).toContain("Unknown command 'frobnicate'.");
  });
});
