import { createGatewayApp } from "./app.js";
import {
  affinitySecret,
  registerGatewayTestCleanup,
  repository,
  route,
  startUpstream,
} from "./app.test-support.js";
import type { EveVersionInfo } from "@evelandhq/core/source";
import { createOperationKey } from "./gateway-durable-routing.js";
import { describe, expect, test, vi } from "vitest";

registerGatewayTestCleanup();

function version(version: string, deploymentId: string): EveVersionInfo {
  return {
    version,
    expected: "0.39.x or 0.40.x",
    supportedRanges: ["0.39.x", "0.40.x"],
    supported: true,
    sourceRevisionId: `src-${deploymentId}`,
  };
}

describe("Gateway durable Eve routes", () => {
  test("pins create-once operation retries across a policy flip and cold activation", async () => {
    let firstAttempts = 0;
    const first = await startUpstream((_request, response) => {
      firstAttempts += 1;
      response.writeHead(firstAttempts === 1 ? 503 : 200, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ sessionId: "eve_operation", deployment: "first" }));
    });
    const second = await startUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ sessionId: "eve_other", deployment: "second" }));
    });
    const weighted = route({
      targets: [
        {
          routeId: "route_project",
          deploymentId: "dep_first",
          weight: 10_000,
          variantName: "first",
          hostPort: first.port,
          status: "running",
        },
        {
          routeId: "route_project",
          deploymentId: "dep_second",
          weight: 0,
          variantName: "second",
          hostPort: second.port,
          status: "running",
        },
      ],
    });
    const repo = repository([weighted]);
    repo.getDeploymentEveVersion = vi.fn(async (deploymentId) => version("0.39.3", deploymentId));
    const activationClient = {
      activate: vi.fn(async ({ deploymentId }: { deploymentId: string }) => ({
        leaseId: `lease-${deploymentId}`,
        endpointPort: deploymentId === "dep_first" ? first.port : second.port,
      })),
      renew: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    };
    const app = createGatewayApp(repo, {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      activationClient,
    });
    const request = () =>
      app.request("http://p-alpha.agent.localhost/eve/v1/session", {
        method: "POST",
        headers: { host: "p-alpha.agent.localhost", "content-type": "application/json" },
        body: JSON.stringify({ message: "run once", operationId: "operation-1" }),
      });

    const failedAttempt = await request();
    expect(failedAttempt.status).toBe(503);
    await expect(failedAttempt.json()).resolves.toMatchObject({ deployment: "first" });
    expect(repo.bindings).toHaveLength(0);
    weighted.policyRevision = 2;
    weighted.targets[0]!.weight = 0;
    weighted.targets[0]!.status = "stopped";
    weighted.targets[1]!.weight = 10_000;

    await expect((await request()).json()).resolves.toMatchObject({ deployment: "first" });
    expect(repo.operationBindings).toHaveLength(1);
    expect(repo.operationBindings[0]).toMatchObject({ deploymentId: "dep_first" });
    expect(JSON.stringify(repo.operationBindings)).not.toContain("operation-1");
    expect(repo.bindings).toContainEqual(
      expect.objectContaining({ eveSessionId: "eve_operation", variantName: "first" }),
    );
    expect(activationClient.activate).toHaveBeenLastCalledWith(
      expect.objectContaining({ deploymentId: "dep_first", kind: "turn" }),
      expect.any(AbortSignal),
    );
  });

  test("returns 409 when the selected target runs an unsupported Eve version", async () => {
    const repo = repository([route()]);
    repo.getDeploymentEveVersion = vi.fn(async (deploymentId) => ({
      ...version("0.37.1", deploymentId),
      supported: false,
    }));
    const activationClient = {
      activate: vi.fn(async () => ({ leaseId: "unused", endpointPort: 0 })),
      renew: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    };
    const app = createGatewayApp(repo, {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      activationClient,
    });

    const response = await app.request(
      "http://p-alpha.agent.localhost/eve/v1/task-input/eve%3Atask-input%3Acapability",
      {
        method: "POST",
        headers: { host: "p-alpha.agent.localhost", "content-type": "application/json" },
        body: JSON.stringify({ inputResponses: [{ requestId: "request-1", text: "yes" }] }),
      },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "Unsupported Eve version",
      detail: expect.stringContaining("0.37.1"),
    });
    expect(activationClient.activate).not.toHaveBeenCalled();
  });

  test("binds MCP invocation ids and keeps follow-up tools on the starting deployment", async () => {
    const first = await startUpstream(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        params: { name: string };
      };
      const envelope =
        body.params.name === "agent_start"
          ? {
              jsonrpc: "2.0",
              id: "start",
              result: {
                structuredContent: { invocationId: "eve_invocation", status: "working" },
              },
            }
          : { jsonrpc: "2.0", id: "get", result: { deployment: "first" } };
      if (body.params.name === "agent_start") {
        response.setHeader("content-type", "text/event-stream");
        response.end(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`);
      } else {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(envelope));
      }
    });
    const second = await startUpstream((_request, response) =>
      response.end(JSON.stringify({ deployment: "second" })),
    );
    const weighted = route({
      targets: [
        {
          routeId: "route_project",
          deploymentId: "dep_first",
          weight: 10_000,
          variantName: "first",
          hostPort: first.port,
          status: "running",
        },
        {
          routeId: "route_project",
          deploymentId: "dep_second",
          weight: 0,
          variantName: "second",
          hostPort: second.port,
          status: "running",
        },
      ],
    });
    const repo = repository([weighted]);
    repo.getDeploymentEveVersion = vi.fn(async (deploymentId) => version("0.39.3", deploymentId));
    const activationClient = {
      activate: vi.fn(async ({ deploymentId }: { deploymentId: string }) => ({
        leaseId: `lease-${deploymentId}`,
        endpointPort: deploymentId === "dep_first" ? first.port : second.port,
      })),
      renew: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    };
    const app = createGatewayApp(repo, {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      activationClient,
    });
    const invoke = (name: string, args: Record<string, unknown>) =>
      app.request("http://p-alpha.agent.localhost/custom-mcp", {
        method: "POST",
        headers: { host: "p-alpha.agent.localhost", "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: name,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });

    expect((await invoke("agent_start", { message: "work" })).status).toBe(200);
    expect(repo.bindings).toContainEqual(
      expect.objectContaining({ eveSessionId: "eve_invocation", deploymentId: "dep_first" }),
    );
    weighted.policyRevision = 2;
    weighted.targets[0]!.weight = 0;
    weighted.targets[0]!.status = "stopped";
    weighted.targets[1]!.weight = 10_000;

    await expect(
      (await invoke("agent_get", { invocationId: "eve_invocation" })).json(),
    ).resolves.toMatchObject({
      result: { deployment: "first" },
    });
    expect(activationClient.activate).toHaveBeenLastCalledWith(
      expect.objectContaining({ deploymentId: "dep_first", kind: "turn" }),
      expect.any(AbortSignal),
    );
  });

  test("expires an idle create-once route instead of silently moving its retry", async () => {
    const stable = route();
    const repo = repository([stable]);
    repo.getDeploymentEveVersion = vi.fn(async (deploymentId) => version("0.39.3", deploymentId));
    repo.operationBindings.push({
      id: "opbind_expired",
      projectId: "proj_1",
      operationKey: createOperationKey("expired-operation", affinitySecret),
      routeId: stable.id,
      deploymentId: "dep_1",
      trigger: "api",
      variantName: null,
      experimentId: null,
      createdAt: "2026-08-14T10:00:00.000Z",
      updatedAt: "2026-08-14T10:00:00.000Z",
    });
    const app = createGatewayApp(repo, {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      apiSessionIdleTtlMs: 1_000,
      now: () => new Date("2026-08-14T10:00:01.001Z"),
    });

    const response = await app.request("http://p-alpha.agent.localhost/eve/v1/session", {
      method: "POST",
      headers: { host: "p-alpha.agent.localhost", "content-type": "application/json" },
      body: JSON.stringify({ message: "retry", operationId: "expired-operation" }),
    });

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({ code: "session_expired" });
  });
});
