import { describe, expect, test, vi } from "vitest";
import {
  beginDeviceLogin,
  deployProject,
  pollDeviceToken,
  promoteProjectDeployment,
} from "./api-client.js";

describe("Eveland CLI API client", () => {
  test("uploads a snapshot and deploys it to production by default", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      requests.push({ url: value, init });
      if (value.endsWith("/source-preflights") && init?.method === "POST") {
        expect(init.body).toBeInstanceOf(FormData);
        return json({ preflight: { id: "pre_1", status: "queued" } }, 202);
      }
      if (value.endsWith("/source-preflights/pre_1")) {
        return json({ preflight: { id: "pre_1", status: "completed" } });
      }
      if (value.endsWith("/projects/proj_weather/deployment-operations") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({
          sourcePreflightId: "pre_1",
          target: "production",
          sourceDigest: "sha256:source",
          git: { commitSha: "abc123", branch: "main", dirty: true },
        });
        return json({ operation: { id: "dop_1", status: "importing" } }, 202);
      }
      if (value.endsWith("/projects/proj_weather/deployment-operations/dop_1")) {
        return json({
          operation: {
            id: "dop_1",
            status: "ready",
            deploymentId: "dep_1",
            previewHostname: "abc--weather.agent.example.com",
            productionHostname: "weather.agent.example.com",
          },
        });
      }
      if (value.endsWith("/projects/proj_weather/endpoints")) {
        return json({
          stable: "https://weather.agent.example.com",
          previews: ["https://abc--weather.agent.example.com"],
        });
      }
      throw new Error(`Unexpected request ${value}`);
    });

    const result = await deployProject({
      apiUrl: "https://api.example.com",
      projectId: "proj_weather",
      token: "session-token",
      archive: new Uint8Array([1, 2, 3]),
      sourceDigest: "sha256:source",
      target: "production",
      git: { commitSha: "abc123", branch: "main", dirty: true },
      fetch: fetchMock,
      sleep: async () => {},
    });

    expect(result.url).toBe("https://weather.agent.example.com");
    expect(result.operation).toMatchObject({ deploymentId: "dep_1", status: "ready" });
    expect(requests.every((request) =>
      new Headers(request.init?.headers).get("authorization") === "Bearer session-token"
    )).toBe(true);
  });

  test("uses OAuth device authorization and retries authorization_pending", async () => {
    let tokenPolls = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith("/api/auth/device/code")) {
        expect(JSON.parse(String(init?.body))).toEqual({ client_id: "eveland-cli" });
        return json({
          device_code: "device-code",
          user_code: "ABCD1234",
          verification_uri: "https://app.example.com/device",
          verification_uri_complete: "https://app.example.com/device?user_code=ABCD1234",
          expires_in: 600,
          interval: 5,
        });
      }
      if (value.endsWith("/api/auth/device/token")) {
        tokenPolls += 1;
        return tokenPolls === 1
          ? json({ error: "authorization_pending" }, 400)
          : json({ access_token: "session-token", token_type: "Bearer", expires_in: 2592000 });
      }
      throw new Error(`Unexpected request ${value}`);
    });

    const device = await beginDeviceLogin("https://api.example.com", fetchMock);
    const token = await pollDeviceToken({
      apiUrl: "https://api.example.com",
      device,
      fetch: fetchMock,
      sleep: async () => {},
    });

    expect(device.user_code).toBe("ABCD1234");
    expect(token.access_token).toBe("session-token");
    expect(tokenPolls).toBe(2);
  });

  test("resolves a preview URL to one exact deployment before promotion", async () => {
    const requests: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      requests.push(`${init?.method ?? "GET"} ${value}`);
      if (value.endsWith("/projects/proj_weather/deployments") && init?.method === "GET") {
        return json({
          deployments: [
            { id: "dep_other", deploymentKey: "other" },
            { id: "dep_exact", deploymentKey: "abc123" },
          ],
        });
      }
      if (value.endsWith("/deployments/dep_exact/promote") && init?.method === "POST") {
        return json({ route: { hostname: "weather.agent.example.com" } });
      }
      if (value.endsWith("/projects/proj_weather/endpoints")) {
        return json({ stable: "https://weather.agent.example.com" });
      }
      throw new Error(`Unexpected request ${value}`);
    });

    await expect(promoteProjectDeployment({
      apiUrl: "https://api.example.com",
      projectId: "proj_weather",
      deployment: "https://abc123--weather.agent.example.com",
      token: "session-token",
      fetch: fetchMock,
    })).resolves.toEqual({
      deploymentId: "dep_exact",
      url: "https://weather.agent.example.com",
    });
    expect(requests).toContain(
      "POST https://api.example.com/projects/proj_weather/deployments/dep_exact/promote",
    );
  });
});

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
