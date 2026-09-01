import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { credentialFilePath, runImplicitLogin } from "./implicit-login.ts";
import type { FetchLike } from "./lifecycle.ts";

const ORIGIN = "http://localhost:17300";
const API = "http://127.0.0.1:17301";

type ServerState = {
  approved: boolean;
  claimed: boolean;
  polls: number;
  signIns: Array<{ email: string; password: string }>;
  originHeaders: string[];
};

function fakeServer(options: { pendingPolls?: number; denySignIn?: boolean } = {}) {
  const state: ServerState = {
    approved: false,
    claimed: false,
    polls: 0,
    signIns: [],
    originHeaders: [],
  };
  const fetchImpl: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers);
    if (headers.get("origin")) state.originHeaders.push(headers.get("origin")!);
    const { pathname } = new URL(url);
    if (pathname === "/api/auth/device/code") {
      return Response.json({ device_code: "dev-123", user_code: "ABCD-EFGH", interval: 5 });
    }
    if (pathname === "/api/auth/sign-in/email") {
      const body = JSON.parse(String(init?.body)) as { email: string; password: string };
      state.signIns.push(body);
      if (options.denySignIn)
        return Response.json({ message: "invalid credentials" }, { status: 401 });
      return new Response("{}", {
        status: 200,
        headers: { "set-cookie": "better-auth.session_token=cookie-value; Path=/; HttpOnly" },
      });
    }
    if (pathname === "/api/auth/device") {
      if (!headers.get("cookie")) return new Response("{}", { status: 401 });
      state.claimed = true;
      return Response.json({ user_code: "ABCD-EFGH", status: "pending" });
    }
    if (pathname === "/api/auth/device/approve") {
      if (!state.claimed) return Response.json({ error: "not claimed" }, { status: 400 });
      if (!headers.get("cookie")) return new Response("{}", { status: 401 });
      state.approved = true;
      return new Response("{}", { status: 200 });
    }
    if (pathname === "/api/auth/oauth2/token") {
      state.polls += 1;
      if (!state.approved || state.polls <= (options.pendingPolls ?? 0)) {
        return Response.json({ error: "authorization_pending" }, { status: 400 });
      }
      return Response.json({
        access_token: "tok-secret",
        token_type: "Bearer",
        scope: "deploy observe",
        expires_in: 2_592_000,
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  return { state, fetchImpl };
}

async function makeEnv() {
  const configHome = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-login-"));
  return { XDG_CONFIG_HOME: configHome } as NodeJS.ProcessEnv;
}

describe("runImplicitLogin", () => {
  test("mints a scoped token headlessly and stores it in the CLI's credential format", async () => {
    const { state, fetchImpl } = fakeServer();
    const env = await makeEnv();
    const printed: string[] = [];
    const result = await runImplicitLogin({
      apiBaseUrl: API,
      publicOrigin: ORIGIN,
      adminEmail: "admin@example.com",
      adminPassword: "secret-password",
      fetchImpl,
      sleep: async () => {},
      env,
      print: (line) => printed.push(line),
    });
    expect(result.scopes).toEqual(["deploy", "observe"]);
    expect(state.signIns).toEqual([{ email: "admin@example.com", password: "secret-password" }]);
    // Every cross-origin-sensitive POST carried the public origin header.
    expect(new Set(state.originHeaders)).toEqual(new Set([ORIGIN]));

    const filePath = credentialFilePath(ORIGIN, env);
    expect(result.credentialPath).toBe(filePath);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    expect(stored).toMatchObject({
      accessToken: "tok-secret",
      tokenType: "Bearer",
      scopes: ["deploy", "observe"],
    });
    expect(typeof stored.obtainedAt).toBe("string");
    expect(typeof stored.expiresAt).toBe("string");
    expect(printed.join("\n")).toContain("deploy, observe");
  });

  test("waits through authorization_pending polls", async () => {
    const { state, fetchImpl } = fakeServer({ pendingPolls: 2 });
    const env = await makeEnv();
    await runImplicitLogin({
      apiBaseUrl: API,
      publicOrigin: ORIGIN,
      adminEmail: "admin@example.com",
      adminPassword: "secret-password",
      fetchImpl,
      sleep: async () => {},
      env,
      print: () => {},
    });
    expect(state.polls).toBe(3);
  });

  test("a failed admin sign-in surfaces the step, not a JSON parse error", async () => {
    const { fetchImpl } = fakeServer({ denySignIn: true });
    await expect(
      runImplicitLogin({
        apiBaseUrl: API,
        publicOrigin: ORIGIN,
        adminEmail: "admin@example.com",
        adminPassword: "wrong",
        fetchImpl,
        sleep: async () => {},
        env: await makeEnv(),
        print: () => {},
      }),
    ).rejects.toThrow(/admin sign-in.*401/s);
  });

  test("the credential file path matches the eveland CLI's per-origin scheme", () => {
    const env = { XDG_CONFIG_HOME: "/cfg" } as NodeJS.ProcessEnv;
    expect(credentialFilePath("http://localhost:17300", env)).toBe(
      `/cfg/eveland/credentials/${encodeURIComponent("http://localhost:17300")}.json`,
    );
  });
});
