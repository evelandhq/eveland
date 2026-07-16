import { describe, expect, test } from "vitest";
import { createAgentAuthModule, type AgentAuthResult, type AgentAuthTransportRequest } from "./module.js";

describe("AgentAuthModule", () => {
  test("forwards a local-dev connection through the loopback Playground transport without credentials", async () => {
    const module = createAgentAuthModule({
      connectionReader: {
        async getAgentConnection(id) {
          return id === "acon_local"
            ? {
                id,
                target: { kind: "managed-project", projectId: "proj_local" },
                method: "local-dev",
                config: {},
                securityRevision: 1,
              }
            : null;
        },
      },
      transport: {
        async request(input) {
          return Response.json(input satisfies AgentAuthTransportRequest, { status: 202 });
        },
      },
    });

    const response = await module.request(
      { agentConnectionId: "acon_local", callerPrincipalId: "member_local" },
      { pathname: "/eve/v1/session" },
      {
        method: "POST",
        body: new TextEncoder().encode('{"message":"hello"}'),
        contentType: "application/json",
      },
    );

    expectResponse(response);
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      target: { kind: "managed-project", projectId: "proj_local" },
      authority: "loopback",
      credential: { kind: "none" },
      request: { pathname: "/eve/v1/session" },
      init: {
        method: "POST",
        body: { 0: 123, 1: 34, 2: 109, 3: 101, 4: 115, 5: 115, 6: 97, 7: 103, 8: 101, 9: 34, 10: 58, 11: 34, 12: 104, 13: 101, 14: 108, 15: 108, 16: 111, 17: 34, 18: 125 },
        contentType: "application/json",
      },
    });
  });

  test("uses a registered auth method without changing the request pipeline", async () => {
    const module = createAgentAuthModule({
      connectionReader: {
        async getAgentConnection(id) {
          return {
            id,
            target: { kind: "managed-project", projectId: "proj_registered" },
            method: "future-token",
            config: { token: "issued-token" },
            securityRevision: 4,
          };
        },
      },
      registrations: [
        {
          method: "future-token",
          credentialScope: "connection",
          authority: "canonical",
          async getCredential({ config }) {
            const token = (config as { token: string }).token;
            return { kind: "headers", headers: [["authorization", `Bearer ${token}`]] };
          },
        },
      ],
      transport: {
        async request(input) {
          return Response.json(input);
        },
      },
    });

    const response = await module.request(
      { agentConnectionId: "acon_registered", callerPrincipalId: "member_registered" },
      { pathname: "/eve/v1/info" },
      { method: "GET", accept: "application/json" },
    );

    expectResponse(response);
    await expect(response.json()).resolves.toEqual({
      target: { kind: "managed-project", projectId: "proj_registered" },
      authority: "canonical",
      credential: { kind: "headers", headers: [["authorization", "Bearer issued-token"]] },
      request: { pathname: "/eve/v1/info" },
      init: { method: "GET", accept: "application/json" },
    });
  });

  test("returns an interactive provider failure without sending the pending first turn upstream", async () => {
    let transportRequests = 0;
    const module = createAgentAuthModule({
      connectionReader: {
        async getAgentConnection(id) {
          return {
            id,
            target: { kind: "managed-project", projectId: "proj_oidc" },
            method: "oidc",
            config: { issuer: "https://idp.example" },
            securityRevision: 1,
          };
        },
      },
      registrations: [{
        method: "oidc",
        credentialScope: "principal",
        authority: "canonical",
        async getCredential() {
          return {
            code: "interaction_required",
            method: "oidc",
            message: "Authorize this Agent Connection before sending a message.",
            interaction: {
              type: "redirect",
              url: "/agent-connections/acon_oidc/auth/interactions/oidc/start?returnPath=%2Fprojects%2Fproj_oidc%2Fplayground",
            },
          };
        },
      }],
      transport: {
        async request() {
          transportRequests += 1;
          return new Response(null, { status: 204 });
        },
      },
    });

    const result = await module.request(
      { agentConnectionId: "acon_oidc", callerPrincipalId: "eveland-member-not-agent-subject" },
      { pathname: "/eve/v1/session" },
      { method: "POST" },
    );

    expect(result).toEqual(expect.objectContaining({ code: "interaction_required", method: "oidc" }));
    expect(transportRequests).toBe(0);
  });

  test("materializes a configured bearer credential for a canonical Agent request", async () => {
    const module = createAgentAuthModule({
      connectionReader: {
        async getAgentConnection(id) {
          return {
            id,
            target: { kind: "managed-project", projectId: "proj_bearer" },
            method: "bearer",
            config: { token: "signed-agent-token" },
            securityRevision: 2,
          };
        },
      },
      transport: {
        async request(input) {
          return Response.json(input);
        },
      },
    });

    const response = await module.request(
      { agentConnectionId: "acon_bearer", callerPrincipalId: "member_bearer" },
      { pathname: "/eve/v1/session" },
      { method: "POST" },
    );

    expectResponse(response);
    await expect(response.json()).resolves.toMatchObject({
      authority: "canonical",
      credential: { kind: "headers", headers: [["authorization", "Bearer signed-agent-token"]] },
    });
  });

  test("materializes HTTP Basic credentials for a canonical Agent request", async () => {
    const module = createAgentAuthModule({
      connectionReader: {
        async getAgentConnection(id) {
          return {
            id,
            target: { kind: "managed-project", projectId: "proj_basic" },
            method: "basic",
            config: { username: "alice", password: "secret" },
            securityRevision: 1,
          };
        },
      },
      transport: { async request(input) { return Response.json(input); } },
    });

    const response = await module.request(
      { agentConnectionId: "acon_basic", callerPrincipalId: "member_basic" },
      { pathname: "/eve/v1/info" },
      { method: "GET" },
    );

    expectResponse(response);
    await expect(response.json()).resolves.toMatchObject({
      authority: "canonical",
      credential: { kind: "headers", headers: [["authorization", "Basic YWxpY2U6c2VjcmV0"]] },
    });
  });

  test("uses the canonical Agent authority for an unauthenticated connection", async () => {
    const module = createAgentAuthModule({
      connectionReader: {
        async getAgentConnection(id) {
          return {
            id,
            target: { kind: "managed-project", projectId: "proj_none" },
            method: "none",
            config: {},
            securityRevision: 1,
          };
        },
      },
      transport: { async request(input) { return Response.json(input); } },
    });

    const response = await module.request(
      { agentConnectionId: "acon_none", callerPrincipalId: "member_none" },
      { pathname: "/eve/v1/session" },
      { method: "POST" },
    );

    expectResponse(response);
    await expect(response.json()).resolves.toMatchObject({
      authority: "canonical",
      credential: { kind: "none" },
    });
  });

  test("materializes configured custom headers in deterministic order", async () => {
    const module = createAgentAuthModule({
      connectionReader: {
        async getAgentConnection(id) {
          return {
            id,
            target: { kind: "managed-project", projectId: "proj_headers" },
            method: "headers",
            config: { headers: { "X-Tenant": "acme", "X-Api-Key": "api-secret" } },
            securityRevision: 1,
          };
        },
      },
      transport: { async request(input) { return Response.json(input); } },
    });

    const response = await module.request(
      { agentConnectionId: "acon_headers", callerPrincipalId: "member_headers" },
      { pathname: "/eve/v1/session" },
      { method: "POST" },
    );

    expectResponse(response);
    await expect(response.json()).resolves.toMatchObject({
      authority: "canonical",
      credential: {
        kind: "headers",
        headers: [["x-api-key", "api-secret"], ["x-tenant", "acme"]],
      },
    });
  });

  test("rejects a dangerous custom credential header before transport", async () => {
    const module = createAgentAuthModule({
      connectionReader: {
        async getAgentConnection(id) {
          return {
            id,
            target: { kind: "managed-project", projectId: "proj_dangerous_header" },
            method: "headers",
            config: { headers: { Host: "attacker.example" } },
            securityRevision: 1,
          };
        },
      },
      transport: {
        async request() {
          throw new Error("Transport must not receive an invalid credential.");
        },
      },
    });

    await expect(module.request(
      { agentConnectionId: "acon_dangerous_header", callerPrincipalId: "member_headers" },
      { pathname: "/eve/v1/session" },
      { method: "POST" },
    )).resolves.toEqual({
      code: "configuration_invalid",
      method: "headers",
      message: "Agent credential header host is not allowed.",
    });
  });

  test("recovers one 401 and never sends a third upstream request after a second 401", async () => {
    let upstreamRequests = 0;
    let canceledResponses = 0;
    const recoveryAttempts: number[] = [];
    const module = createAgentAuthModule({
      connectionReader: {
        async getAgentConnection(id) {
          return {
            id,
            target: { kind: "managed-project", projectId: "proj_retry" },
            method: "refreshing-token",
            config: {},
            securityRevision: 3,
          };
        },
      },
      registrations: [{
        method: "refreshing-token",
        credentialScope: "principal",
        authority: "canonical",
        async getCredential() {
          return { kind: "headers", headers: [["authorization", "Bearer rejected-token"]] };
        },
        async recoverUnauthorized({ attempt }) {
          recoveryAttempts.push(attempt);
          return attempt === 0
            ? { action: "retry" }
            : {
                action: "give_up",
                failure: {
                  code: "credential_rejected",
                  method: "refreshing-token",
                  message: "The Agent rejected the refreshed credential.",
                },
              };
        },
      }],
      transport: {
        async request() {
          upstreamRequests += 1;
          return new Response(new ReadableStream({
            cancel() {
              canceledResponses += 1;
            },
          }), { status: 401 });
        },
      },
    });

    const result = await module.request(
      { agentConnectionId: "acon_retry", callerPrincipalId: "member_retry" },
      { pathname: "/eve/v1/session" },
      { method: "POST" },
    );

    expect(result).toMatchObject({ code: "credential_rejected", method: "refreshing-token" });
    expect(upstreamRequests).toBe(2);
    expect(recoveryAttempts).toEqual([0, 1]);
    expect(canceledResponses).toBe(2);
  });
});

function expectResponse(result: AgentAuthResult): asserts result is Response {
  expect(result).toBeInstanceOf(Response);
  if (!(result instanceof Response)) throw new Error(`Expected Response, received ${result.code}.`);
}
