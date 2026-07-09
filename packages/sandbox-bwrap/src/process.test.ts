import { describe, expect, test } from "vitest";
import { WORKSPACE_ROOT } from "./paths.js";
import { createNodeProcessRunner, describeMissingPrereqs, isBwrapAvailable } from "./process.js";

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

describe("createNodeProcessRunner", () => {
  const runner = createNodeProcessRunner();

  test("captures stdout, stderr, and the exit code", async () => {
    const proc = runner.spawn(["sh", "-c", "echo out; echo err >&2; exit 7"]);
    const [stdout, stderr, result] = await Promise.all([readAll(proc.stdout), readAll(proc.stderr), proc.wait()]);
    expect(stdout).toBe("out\n");
    expect(stderr).toBe("err\n");
    expect(result.exitCode).toBe(7);
  });

  test("kill terminates the whole process group promptly and is idempotent", async () => {
    const proc = runner.spawn(["sh", "-c", "sleep 30"]);
    const started = Date.now();
    await proc.kill();
    await proc.kill();
    await proc.wait().catch(() => undefined);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("abort makes wait() reject with the abort reason", async () => {
    const controller = new AbortController();
    const proc = runner.spawn(["sh", "-c", "sleep 30"], { abortSignal: controller.signal });
    const waiting = proc.wait();
    controller.abort(new Error("stop-now"));
    await expect(waiting).rejects.toThrow("stop-now");
  });

  test("spawning a missing executable rejects wait()", async () => {
    const proc = runner.spawn(["definitely-not-a-real-binary-xyz"]);
    await expect(proc.wait()).rejects.toThrow();
  });
});

describe("isBwrapAvailable", () => {
  test("returns false for a missing binary", () => {
    expect(isBwrapAvailable("definitely-not-a-real-binary-xyz")).toBe(false);
  });
});

describe("describeMissingPrereqs", () => {
  test("returns null when bwrap is present and the workspace mountpoint exists", () => {
    expect(
      describeMissingPrereqs({ bwrapPresent: true, workspaceMountpointPresent: true, bwrapPath: "bwrap" }),
    ).toBeNull();
  });

  test("reports a missing bwrap binary with the probed path and an install hint", () => {
    const message = describeMissingPrereqs({
      bwrapPresent: false,
      workspaceMountpointPresent: true,
      bwrapPath: "/custom/bwrap",
    });
    expect(message).toContain("/custom/bwrap");
    expect(message).toContain("apt-get install bubblewrap");
    expect(message).not.toContain(WORKSPACE_ROOT);
  });

  test("reports a missing workspace mountpoint naming WORKSPACE_ROOT with the fix command", () => {
    const message = describeMissingPrereqs({
      bwrapPresent: true,
      workspaceMountpointPresent: false,
      bwrapPath: "bwrap",
    });
    expect(message).toContain(WORKSPACE_ROOT);
    expect(message).toContain(`sudo install -d -m 0755 ${WORKSPACE_ROOT}`);
    expect(message).not.toContain("apt-get install bubblewrap");
  });

  test("reports both, bwrap first, when both are missing", () => {
    const message = describeMissingPrereqs({
      bwrapPresent: false,
      workspaceMountpointPresent: false,
      bwrapPath: "bwrap",
    });
    expect(message).toContain("apt-get install bubblewrap");
    expect(message).toContain(WORKSPACE_ROOT);
    expect(message?.indexOf("apt-get install bubblewrap")).toBeLessThan(message?.indexOf(WORKSPACE_ROOT) ?? -1);
  });
});
