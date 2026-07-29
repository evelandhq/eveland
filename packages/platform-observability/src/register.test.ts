import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

describe("platform observability ESM registration", () => {
  test("instruments Node HTTP before the application module graph loads", async () => {
    const entrypoint = fileURLToPath(
      new URL("./register-http.test-support.ts", import.meta.url),
    );
    const registerEntrypoint = fileURLToPath(
      new URL("./register.ts", import.meta.url),
    );
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        registerEntrypoint,
        entrypoint,
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
      },
    );
    const result = JSON.parse(stdout) as {
      serverSpans: Array<{ scope: string; path: string }>;
      serverDuration: {
        serviceName: string;
        unit: string;
        attributes: Array<Record<string, unknown>>;
      } | null;
    };

    expect(result.serverSpans).toEqual([
      {
        scope: "@opentelemetry/instrumentation-http",
        path: "/probe",
      },
    ]);
    expect(result.serverDuration).toMatchObject({
      serviceName: "eveland-api",
      unit: "s",
      attributes: [
        {
          "http.request.method": "GET",
          "http.response.status_code": 200,
        },
      ],
    });
  });
});
