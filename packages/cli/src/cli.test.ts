import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { FetchLike } from "./api-client.ts";
import { loadCredential } from "./credentials.ts";
import { runCli, unknownCommandMessage } from "./cli.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function makeIo(fetchImpl?: FetchLike, extraEnv: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const env: NodeJS.ProcessEnv = {
    XDG_CONFIG_HOME: await mkdtemp(path.join(os.tmpdir(), "eveland-cli-io-")),
    ...extraEnv,
  };
  return {
    io: {
      env,
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
      fetchImpl,
      openUrl: async () => {},
      sleep: async () => {},
    },
    out,
    err,
    env,
  };
}

const MEMBER = {
  member: {
    email: "admin@example.com",
    name: "Admin",
    role: "admin",
    tokenScopes: ["deploy", "observe"],
  },
};

describe("eveland CLI", () => {
  test("help lists the command surface; unknown commands suggest corrections", async () => {
    const { io, out } = await makeIo();
    expect(await runCli(["help"], io)).toBe(0);
    const help = out.join("\n");
    expect(help).toContain("login");
    expect(help).toContain("logout");
    expect(help).toContain("whoami");

    expect(unknownCommandMessage("wohami")).toContain("`eveland whoami`");
    expect(unknownCommandMessage("doctor")).toContain("`eveland-ctl doctor`");
    expect(unknownCommandMessage("doctr")).toContain("`eveland-ctl doctor`");
    expect(unknownCommandMessage("frobnicate")).not.toContain("Did you mean");
  });

  test("login runs the device flow, stores the credential, and reports the user", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.endsWith("/api/auth/device/code")) {
        return jsonResponse(200, {
          device_code: "dc",
          user_code: "CODE-1234",
          verification_uri: "http://localhost:17300/device",
          verification_uri_complete: "http://localhost:17300/device?user_code=CODE-1234",
          expires_in: 900,
          interval: 5,
        });
      }
      if (url.endsWith("/api/auth/oauth2/token")) {
        return jsonResponse(200, {
          access_token: "token-xyz",
          token_type: "Bearer",
          scope: "deploy observe",
          expires_in: 3600,
        });
      }
      if (url.endsWith("/api/members/me")) return jsonResponse(200, MEMBER);
      throw new Error(`Unexpected request: ${url}`);
    };
    const { io, out, env } = await makeIo(fetchImpl);

    expect(await runCli(["login", "--origin", "http://localhost:17300"], io)).toBe(0);
    expect(out.join("\n")).toContain("Logged in to http://localhost:17300 as admin@example.com.");
    await expect(loadCredential("http://localhost:17300", env)).resolves.toMatchObject({
      accessToken: "token-xyz",
      scopes: ["deploy", "observe"],
    });
  });

  test("whoami prints identity and token provenance; logout forgets it", async () => {
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.endsWith("/api/members/me")) {
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer ci-token");
        return jsonResponse(200, MEMBER);
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    const { io, out } = await makeIo(fetchImpl, { EVELAND_TOKEN: "ci-token" });
    expect(await runCli(["whoami", "--origin", "http://localhost:17300"], io)).toBe(0);
    const printed = out.join("\n");
    expect(printed).toContain("admin@example.com");
    expect(printed).toContain("deploy, observe");
    expect(printed).toContain("EVELAND_TOKEN");

    const { io: loggedOutIo, err } = await makeIo(fetchImpl);
    expect(await runCli(["whoami", "--origin", "http://localhost:17300"], loggedOutIo)).toBe(1);
    expect(err.join("\n")).toContain("Not logged in");
  });

  test("a 401 from the API becomes a login hint, not a stack trace", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(401, { error: "Authentication required" });
    const { io, err } = await makeIo(fetchImpl, { EVELAND_TOKEN: "stale" });
    expect(await runCli(["whoami", "--origin", "http://localhost:17300"], io)).toBe(1);
    expect(err.join("\n")).toContain("Run `eveland login`");
  });
});
