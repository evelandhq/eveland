import { describe, expect, test } from "vitest";
import { createNodeProcessRunner, isBwrapAvailable } from "./process.js";

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
