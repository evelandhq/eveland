import { describe, expect, test, vi } from "vitest";
import { createGatewayApp } from "./app.js";
import {
  affinitySecret,
  registerGatewayTestCleanup,
  repository,
  route,
  startUpstream,
} from "./app.test-support.js";

registerGatewayTestCleanup();

describe("Gateway open-access identity injection", () => {
  test("injects a Caller Token only when the caller sent no credential of its own", async () => {
    const upstream = await startUpstream((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(request.headers));
    });
    const identityClient = { callerToken: vi.fn(async () => "minted-token") };
    const app = createGatewayApp(repository([route({ hostPort: upstream.port })]), {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      identityClient,
    });

    const anonymous = (await (
      await app.request("http://p-alpha.agent.localhost/eve/v1/session", {
        method: "POST",
        headers: { host: "p-alpha.agent.localhost:4080", "content-type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      })
    ).json()) as Record<string, string>;
    expect(anonymous.authorization).toBe("Bearer minted-token");

    // An Agent-owned Authorization stays untouched: the Gateway cannot verify
    // it, that is the Agent's job, and replacing one would break every Agent
    // running its own authentication.
    const credentialed = (await (
      await app.request("http://p-alpha.agent.localhost/eve/v1/session", {
        method: "POST",
        headers: {
          host: "p-alpha.agent.localhost:4080",
          authorization: "Bearer agent-owned",
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: "hello" }),
      })
    ).json()) as Record<string, string>;
    expect(credentialed.authorization).toBe("Bearer agent-owned");
    expect(identityClient.callerToken).toHaveBeenCalledTimes(1);
    expect(identityClient.callerToken).toHaveBeenCalledWith("proj_1");
  });

  test("forwards the request unchanged when no token can be minted", async () => {
    const upstream = await startUpstream((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(request.headers));
    });
    const app = createGatewayApp(repository([route({ hostPort: upstream.port })]), {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      identityClient: { callerToken: async () => null },
    });

    const response = await app.request("http://p-alpha.agent.localhost/eve/v1/session", {
      method: "POST",
      headers: { host: "p-alpha.agent.localhost:4080", "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });

    // A degraded Identity service must not stop traffic reaching Agents that
    // never asked for an Eveland identity; their own auth chain still decides.
    expect(response.status).toBe(200);
    const headers = (await response.json()) as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  test("keeps stripping x-eveland-* and the affinity cookie while injecting", async () => {
    const upstream = await startUpstream((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(request.headers));
    });
    const app = createGatewayApp(repository([route({ hostPort: upstream.port })]), {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      identityClient: { callerToken: async () => "minted-token" },
    });

    const response = await app.request("http://p-alpha.agent.localhost/eve/v1/session", {
      method: "POST",
      headers: {
        host: "p-alpha.agent.localhost:4080",
        "content-type": "application/json",
        cookie: "app_session=user; eveland_affinity=forged",
        "x-eveland-runtime-secret": "forged",
        "x-eveland-agent-auth": "forged",
      },
      body: JSON.stringify({ message: "hello" }),
    });
    const headers = (await response.json()) as Record<string, string>;

    // That stripping is load-bearing: the scheduler channel authenticates on
    // x-eveland-runtime-secret and never reaches routeAuth, and the Playground
    // envelope header would otherwise be forgeable from the public internet.
    expect(headers.authorization).toBe("Bearer minted-token");
    expect(headers["x-eveland-runtime-secret"]).toBeUndefined();
    expect(headers["x-eveland-agent-auth"]).toBeUndefined();
    expect(headers.cookie).toBe("app_session=user");
  });

  test("never injects into the internal Playground path", async () => {
    const upstream = await startUpstream((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(request.headers));
    });
    const identityClient = { callerToken: vi.fn(async () => "minted-token") };
    const app = createGatewayApp(repository([route({ hostPort: upstream.port })]), {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      internalServiceToken: "service-token",
      identityClient,
    });

    const response = await app.request(
      "http://gateway/internal/projects/proj_1/playground/eve/v1/session",
      {
        method: "POST",
        headers: {
          authorization: "Bearer service-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: "hello" }),
      },
    );

    // The Playground builds its headers from scratch and injects whatever the
    // project's own Playground authentication method resolved. Minting here
    // too would silently override that choice.
    expect(response.status).toBe(200);
    expect(identityClient.callerToken).not.toHaveBeenCalled();
  });
});
