import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

describe("OTLP protobuf Node.js compatibility", () => {
  test("loads the codec through the native Node.js ESM loader", async () => {
    const moduleUrl = new URL("./otlp/protobuf.ts", import.meta.url).href;
    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--eval", `await import(${JSON.stringify(moduleUrl)})`],
      {
        cwd: new URL("..", import.meta.url),
      },
    );

    expect(result.stderr).toBe("");
  });
});
