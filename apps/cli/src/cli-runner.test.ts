import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { runCli } from "./cli-runner.js";

describe("eveland command", () => {
  test("shows help when invoked without a subcommand", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    await expect(runCli(["--help"], {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    })).resolves.toBe(0);

    expect(stdout.join("")).toContain("eveland deploy [path]");
    expect(stderr).toEqual([]);
  });

  test("deploys the current directory to production and prints only its URL to stdout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eveland-cli-deploy-"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "agent" }));
    await writeFile(path.join(root, "agent.ts"), "export default {};\n");
    const stdout: string[] = [];
    const stderr: string[] = [];
    let operationInput: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith("/source-preflights") && init?.method === "POST") {
        return json({ preflight: { id: "pre_cli", status: "queued" } }, 202);
      }
      if (value.endsWith("/source-preflights/pre_cli")) {
        return json({ preflight: { id: "pre_cli", status: "completed" } });
      }
      if (value.endsWith("/deployment-operations") && init?.method === "POST") {
        operationInput = JSON.parse(String(init.body));
        return json({ operation: { id: "dop_cli", status: "importing" } }, 202);
      }
      if (value.endsWith("/deployment-operations/dop_cli")) {
        return json({
          operation: {
            id: "dop_cli",
            status: "ready",
            deploymentId: "dep_cli",
            productionHostname: "agent.example.com",
          },
        });
      }
      if (value.endsWith("/endpoints")) {
        return json({ stable: "https://agent.example.com", previews: [] });
      }
      throw new Error(`Unexpected request ${value}`);
    });

    const exitCode = await runCli(
      [
        "deploy",
        root,
        "--project",
        "proj_cli",
        "--url",
        "https://eveland.example.com",
      ],
      {
        cwd: root,
        env: { EVELAND_TOKEN: "ci-token" },
        fetch: fetchMock,
        sleep: async () => {},
        stdout: (value) => stdout.push(value),
        stderr: (value) => stderr.push(value),
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout.join("")).toBe("https://agent.example.com\n");
    expect(stderr.join("")).toContain("Deploying to production");
    expect(operationInput).toMatchObject({ target: "production" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://eveland.example.com/api/eveland/source-preflights",
    );
  });

  test("logs in through the instance's same-origin API mount", async () => {
    const stdout: string[] = [];
    const requests: string[] = [];
    const credentials = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    };
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      requests.push(value);
      if (value.endsWith("/api/auth/device/code")) {
        return json({
          device_code: "device-code",
          user_code: "ABCD1234",
          verification_uri: "https://eveland.example.com/auth/device",
          verification_uri_complete: "https://eveland.example.com/auth/device?user_code=ABCD1234",
          expires_in: 600,
          interval: 5,
        });
      }
      if (value.endsWith("/api/auth/device/token")) {
        return json({ access_token: "session-token", token_type: "Bearer", expires_in: 2592000 });
      }
      throw new Error(`Unexpected request ${value}`);
    });

    await expect(runCli([
      "login",
      "--url",
      "https://eveland.example.com/",
      "--no-open",
    ], {
      fetch: fetchMock,
      credentials,
      stdout: (value) => stdout.push(value),
      stderr: () => {},
    })).resolves.toBe(0);

    expect(requests).toEqual([
      "https://eveland.example.com/api/eveland/api/auth/device/code",
      "https://eveland.example.com/api/eveland/api/auth/device/token",
    ]);
    expect(credentials.set).toHaveBeenCalledWith(
      "https://eveland.example.com",
      expect.objectContaining({ token: "session-token" }),
    );
    expect(stdout.join("")).toBe("Logged in to https://eveland.example.com\n");
  });

  test("requires --preview to avoid production promotion", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eveland-cli-preview-"));
    await writeFile(path.join(root, "agent.ts"), "export default {};\n");
    let target: unknown;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith("/source-preflights") && init?.method === "POST") return json({ preflight: { id: "pre_1" } }, 202);
      if (value.endsWith("/source-preflights/pre_1")) return json({ preflight: { id: "pre_1", status: "completed" } });
      if (value.endsWith("/deployment-operations") && init?.method === "POST") {
        target = (JSON.parse(String(init.body)) as { target: unknown }).target;
        return json({ operation: { id: "dop_1" } }, 202);
      }
      if (value.endsWith("/deployment-operations/dop_1")) return json({ operation: { id: "dop_1", status: "ready", previewHostname: "abc--agent.example.com" } });
      if (value.endsWith("/endpoints")) return json({ stable: "https://agent.example.com", previews: ["https://abc--agent.example.com"] });
      throw new Error(`Unexpected request ${value}`);
    });

    await runCli(["deploy", root, "--preview", "--project", "proj_cli"], {
      cwd: root,
      env: { EVELAND_TOKEN: "ci-token", EVELAND_URL: "https://eveland.example.com" },
      fetch: fetchMock,
      sleep: async () => {},
      stdout: () => {},
      stderr: () => {},
    });

    expect(target).toBe("preview");
  });
});

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
