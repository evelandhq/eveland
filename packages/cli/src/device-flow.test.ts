import { describe, expect, test } from "vitest";
import type { FetchLike } from "./api-client.ts";
import { CLI_REQUESTED_SCOPE, EVELAND_CLI_CLIENT_ID, runDeviceFlow } from "./device-flow.ts";

const ISSUED = {
  device_code: "device-code-1",
  user_code: "ABCD-EFGH",
  verification_uri: "http://localhost:17300/device",
  verification_uri_complete: "http://localhost:17300/device?user_code=ABCD-EFGH",
  expires_in: 900,
  interval: 5,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A scripted token endpoint: each poll shifts the next answer. */
function fakeServer(tokenAnswers: Array<() => Response>) {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: (init?.body as string) ?? "" });
    if (url.endsWith("/api/auth/device/code")) return jsonResponse(200, ISSUED);
    if (url.endsWith("/api/auth/oauth2/token")) {
      const answer = tokenAnswers.shift();
      if (!answer) throw new Error("Token endpoint polled more often than scripted.");
      return answer();
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  return { fetchImpl, calls };
}

function collectingIo(server: ReturnType<typeof fakeServer>, sleeps: number[]) {
  const printed: string[] = [];
  const opened: string[] = [];
  return {
    io: {
      fetchImpl: server.fetchImpl,
      print: (line: string) => printed.push(line),
      openUrl: async (url: string) => {
        opened.push(url);
      },
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    },
    printed,
    opened,
  };
}

describe("runDeviceFlow", () => {
  test("requests a code, opens the approval page, and polls to a token", async () => {
    const server = fakeServer([
      () => jsonResponse(400, { error: "authorization_pending", error_description: "pending" }),
      () =>
        jsonResponse(200, {
          access_token: "token-1",
          token_type: "Bearer",
          scope: "deploy observe",
          expires_in: 3600,
        }),
    ]);
    const sleeps: number[] = [];
    const { io, printed, opened } = collectingIo(server, sleeps);

    const result = await runDeviceFlow("http://localhost:17300", io);

    expect(result.accessToken).toBe("token-1");
    expect(result.scopes).toEqual(["deploy", "observe"]);
    expect(result.expiresAt).not.toBeNull();
    expect(opened).toEqual([ISSUED.verification_uri_complete]);
    expect(printed.join("\n")).toContain("ABCD-EFGH");
    expect(sleeps).toEqual([5_000, 5_000]);

    const codeRequest = server.calls[0]!;
    expect(JSON.parse(codeRequest.body)).toEqual({
      client_id: EVELAND_CLI_CLIENT_ID,
      scope: CLI_REQUESTED_SCOPE,
    });
    // Token polling is form-encoded per RFC 6749.
    expect(server.calls[1]!.body).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3A");
  });

  test("slow_down widens the polling interval by five seconds", async () => {
    const server = fakeServer([
      () => jsonResponse(400, { error: "slow_down", error_description: "too fast" }),
      () => jsonResponse(400, { error: "authorization_pending", error_description: "pending" }),
      () => jsonResponse(200, { access_token: "token-2", token_type: "Bearer", scope: "deploy" }),
    ]);
    const sleeps: number[] = [];
    const { io } = collectingIo(server, sleeps);

    await runDeviceFlow("http://localhost:17300", io);

    expect(sleeps).toEqual([5_000, 10_000, 10_000]);
  });

  test("denial and expiry become actionable errors", async () => {
    const denied = fakeServer([
      () => jsonResponse(400, { error: "access_denied", error_description: "denied" }),
    ]);
    await expect(
      runDeviceFlow("http://localhost:17300", collectingIo(denied, []).io),
    ).rejects.toThrow(/denied in the Dashboard/);

    const expired = fakeServer([
      () => jsonResponse(400, { error: "expired_token", error_description: "expired" }),
    ]);
    await expect(
      runDeviceFlow("http://localhost:17300", collectingIo(expired, []).io),
    ).rejects.toThrow(/expired before it was approved/);
  });

  test("gives up when the code's lifetime elapses without approval", async () => {
    const server = fakeServer([
      () => jsonResponse(400, { error: "authorization_pending", error_description: "pending" }),
    ]);
    let clock = 0;
    const io = {
      fetchImpl: server.fetchImpl,
      print: () => {},
      sleep: async () => {
        clock += ISSUED.expires_in * 1_000;
      },
      now: () => clock,
    };
    await expect(runDeviceFlow("http://localhost:17300", io)).rejects.toThrow(
      /expired before it was approved/,
    );
  });
});
