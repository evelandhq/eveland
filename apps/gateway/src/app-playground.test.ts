import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createBuildInfo } from "@eveland/core/build-info";
import { createConfigurationSnapshot } from "@eveland/core/config-diagnostics";
import {
  createGatewayApp,
  type GatewayRepository,
  type ResolvedAgentRoute,
} from "./app.js";
import { affinityBucketForRoute } from "@eveland/core/routing";
import {
  AGENT_AUTH_ENVELOPE_HEADER,
  encodeAgentAuthEnvelope,
} from "@eveland/core/agent-auth";
import {
  activatedSessionPersistenceFailureFixture,
  affinitySecret,
  gatewayServers,
  registerGatewayTestCleanup,
  repository,
  route,
  startUpstream,
} from "./app.test-support.js";

registerGatewayTestCleanup();

describe("Gateway", () => {
  test("returns 410 instead of waking an expired Playground SessionBinding", async () => {
    const repo = repository([route({ deploymentStatus: "stopped" })]);
    repo.bindings.push({
      id: "bind_expired_playground",
      projectId: "proj_1",
      eveSessionId: "eve_expired_playground",
      continuationToken: "continue_expired_playground",
      routeId: "route_project",
      deploymentId: "dep_1",
      trigger: "playground",
      variantName: null,
      experimentId: null,
      requestId: "request_expired_playground",
      remoteIp: null,
      affinityFingerprint: null,
      affinitySource: null,
      createdAt: "2026-07-27T11:59:59.000Z",
      updatedAt: "2026-07-27T11:59:59.000Z",
    });
    const activationClient = {
      activate: vi.fn(async () => ({
        leaseId: "lease_expired_playground",
        endpointPort: 41999,
      })),
      renew: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    };
    const app = createGatewayApp(repo, {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      internalServiceToken: "service-secret",
      activationClient,
      now: () => new Date("2026-07-28T12:00:00.000Z"),
      playgroundSessionIdleTtlMs: 86_400_000,
    });

    const response = await app.request(
      "http://gateway/internal/projects/proj_1/playground/eve/v1/session/eve_expired_playground",
      {
        method: "POST",
        headers: {
          authorization: "Bearer service-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: "too late" }),
      },
    );

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({
      error: "Session expired",
      code: "session_expired",
    });
    expect(activationClient.activate).not.toHaveBeenCalled();
  });

  test.each([
    {
      operation: "continuation",
      path: "/eve/v1/session/eve_persist_playground",
      body: JSON.stringify({ message: "continue" }),
      response: {
        sessionId: "eve_persist_playground",
        continuationToken: "continue_next_playground",
      },
      expectedToken: "continue_next_playground",
    },
    {
      operation: "reset",
      path: "/eve/v1/session/reset",
      body: JSON.stringify({
        continuationToken: "continue_current_playground",
      }),
      response: {
        ok: true,
        previousSessionId: "eve_persist_playground",
        status: "reset",
      },
      expectedToken: null,
    },
  ])(
    "cleans up an activated canonical Playground upstream when $operation binding persistence fails",
    async ({ path, body, response: responseBody, expectedToken }) => {
      const { repo, activationClient, persistenceError } =
        await activatedSessionPersistenceFailureFixture({
          trigger: "playground",
          eveSessionId: "eve_persist_playground",
          continuationToken: "continue_current_playground",
          leaseId: "lease_persist_playground",
          responseBody,
        });
      const cancel = vi.spyOn(ReadableStream.prototype, "cancel");
      const errorLog = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const app = createGatewayApp(repo, {
        allowedBaseDomains: ["agent.localhost"],
        affinitySecret,
        internalServiceToken: "service-secret",
        activationClient,
        now: () => new Date("2026-07-28T12:00:00.000Z"),
      });

      try {
        const result = await app.request(
          `http://gateway/internal/projects/proj_1/playground${path}`,
          {
            method: "POST",
            headers: {
              authorization: "Bearer service-secret",
              "content-type": "application/json",
            },
            body,
          },
        );

        expect(result.status).toBe(500);
        expect(repo.setSessionBindingContinuationToken).toHaveBeenCalledWith(
          "proj_1",
          "eve_persist_playground",
          expectedToken,
        );
        expect(cancel).toHaveBeenCalledWith(persistenceError);
        expect(activationClient.release).toHaveBeenCalledTimes(1);
        expect(activationClient.release).toHaveBeenCalledWith(
          "lease_persist_playground",
        );
      } finally {
        cancel.mockRestore();
        errorLog.mockRestore();
      }
    },
  );

  test("proxies the canonical Eve Playground protocol with streaming, attachments, and pinned continuations", async () => {
    const requests: Array<{
      method: string;
      path: string;
      host: string;
      body: string;
    }> = [];
    const upstream = await startUpstream((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        requests.push({
          method: request.method ?? "GET",
          path: request.url ?? "",
          host: request.headers.host ?? "",
          body: Buffer.concat(chunks).toString("utf8"),
        });
        if (request.method === "POST" && request.url === "/eve/v1/session") {
          response.writeHead(202, {
            "content-type": "application/json",
            "x-eve-session-id": "eve_stream",
          });
          response.end(
            JSON.stringify({
              sessionId: "eve_stream",
              continuationToken: "continue_1",
            }),
          );
          return;
        }
        if (
          request.method === "POST" &&
          request.url === "/eve/v1/session/eve_stream"
        ) {
          response.writeHead(202, {
            "content-type": "application/json",
            "x-eve-session-id": "eve_stream",
          });
          response.end(
            JSON.stringify({
              sessionId: "eve_stream",
              continuationToken: "continue_2",
            }),
          );
          return;
        }
        if (
          request.method === "POST" &&
          request.url === "/eve/v1/session/eve_stream/cancel"
        ) {
          response.writeHead(202, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ sessionId: "eve_stream", status: "accepted" }),
          );
          return;
        }
        if (
          request.method === "POST" &&
          request.url === "/eve/v1/session/reset"
        ) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              ok: true,
              previousSessionId: "eve_stream",
              status: "reset",
            }),
          );
          return;
        }
        if (
          request.method === "GET" &&
          request.url === "/eve/v1/session/eve_stream/stream?startIndex=1&includeTailIndex=1"
        ) {
          response.writeHead(200, {
            "content-type": "application/x-ndjson",
            "x-eve-stream-tail-index": "3",
          });
          response.write(
            `${JSON.stringify({ type: "reasoning.appended", data: { reasoningDelta: "Checking" } })}\n`,
          );
          setTimeout(
            () =>
              response.end(
                `${JSON.stringify({ type: "session.waiting", data: { wait: "next-user-message" } })}\n`,
              ),
            250,
          );
          return;
        }
        response.writeHead(404).end();
      });
    });
    const repo = repository([
      route({ hostPort: upstream.port, deploymentStatus: "stopped" }),
    ]);
    const activationClient = {
      activate: vi.fn(
        async (
          _input: {
            deploymentId: string;
            kind: "public_request" | "stream" | "turn";
            ownerId: string;
          },
          _signal?: AbortSignal,
        ) => ({ leaseId: crypto.randomUUID(), endpointPort: upstream.port }),
      ),
      renew: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    };
    const app = createGatewayApp(repo, {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      internalServiceToken: "service-secret",
      activationClient,
    });
    const initialBody = JSON.stringify({
      message: [
        { type: "text", text: "Read this" },
        {
          type: "file",
          data: "data:text/plain;base64,aGk=",
          filename: "note.txt",
          mediaType: "text/plain",
        },
      ],
    });

    const unauthorized = await app.request(
      "http://gateway/internal/projects/proj_1/playground/eve/v1/session",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: initialBody,
      },
    );
    const initial = await app.request(
      "http://gateway/internal/projects/proj_1/playground/eve/v1/session",
      {
        method: "POST",
        headers: {
          authorization: "Bearer service-secret",
          "content-type": "application/json",
        },
        body: initialBody,
      },
    );
    const continuationBody = JSON.stringify({
      continuationToken: "continue_1",
      inputResponses: [{ requestId: "request_1", optionId: "approve" }],
    });
    const continuation = await app.request(
      "http://gateway/internal/projects/proj_1/playground/eve/v1/session/eve_stream",
      {
        method: "POST",
        headers: {
          authorization: "Bearer service-secret",
          "content-type": "application/json",
        },
        body: continuationBody,
      },
    );
    const cancelBody = JSON.stringify({ turnId: "turn_2" });
    const cancel = await app.request(
      "http://gateway/internal/projects/proj_1/playground/eve/v1/session/eve_stream/cancel",
      {
        method: "POST",
        headers: {
          authorization: "Bearer service-secret",
          "content-type": "application/json",
        },
        body: cancelBody,
      },
    );
    const resetBody = JSON.stringify({ continuationToken: "continue_2" });
    const reset = await app.request(
      "http://gateway/internal/projects/proj_1/playground/eve/v1/session/reset",
      {
        method: "POST",
        headers: {
          authorization: "Bearer service-secret",
          "content-type": "application/json",
        },
        body: resetBody,
      },
    );
    const startedAt = Date.now();
    const stream = await app.request(
      "http://gateway/internal/projects/proj_1/playground/eve/v1/session/eve_stream/stream?startIndex=1&includeTailIndex=1",
      {
        headers: {
          authorization: "Bearer service-secret",
          accept: "application/x-ndjson",
        },
      },
    );
    const reader = stream.body!.getReader();
    const first = await reader.read();

    expect(unauthorized.status).toBe(404);
    expect(initial.status).toBe(202);
    await expect(initial.json()).resolves.toMatchObject({
      sessionId: "eve_stream",
      continuationToken: "continue_1",
    });
    expect(continuation.status).toBe(202);
    await expect(continuation.json()).resolves.toMatchObject({
      continuationToken: "continue_2",
    });
    expect(cancel.status).toBe(202);
    await expect(cancel.json()).resolves.toEqual({
      sessionId: "eve_stream",
      status: "accepted",
    });
    expect(reset.status).toBe(200);
    await expect(reset.json()).resolves.toEqual({
      ok: true,
      previousSessionId: "eve_stream",
      status: "reset",
    });
    expect(new TextDecoder().decode(first.value)).toContain(
      "reasoning.appended",
    );
    expect(stream.headers.get("x-eve-stream-tail-index")).toBe("3");
    expect(Date.now() - startedAt).toBeLessThan(200);
    await reader.cancel();
    expect(requests).toEqual(
      expect.arrayContaining([
        {
          method: "POST",
          path: "/eve/v1/session",
          host: `localhost:${upstream.port}`,
          body: initialBody,
        },
        {
          method: "POST",
          path: "/eve/v1/session/eve_stream",
          host: `localhost:${upstream.port}`,
          body: continuationBody,
        },
        {
          method: "POST",
          path: "/eve/v1/session/eve_stream/cancel",
          host: `localhost:${upstream.port}`,
          body: cancelBody,
        },
        {
          method: "POST",
          path: "/eve/v1/session/reset",
          host: `localhost:${upstream.port}`,
          body: resetBody,
        },
        {
          method: "GET",
          path: "/eve/v1/session/eve_stream/stream?startIndex=1&includeTailIndex=1",
          host: `localhost:${upstream.port}`,
          body: "",
        },
      ]),
    );
    expect(repo.bindings).toContainEqual(
      expect.objectContaining({
        eveSessionId: "eve_stream",
        continuationToken: null,
        trigger: "playground",
      }),
    );
    expect(activationClient.activate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "turn" }),
      expect.any(AbortSignal),
    );
    expect(activationClient.activate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "stream" }),
      expect.any(AbortSignal),
    );
    expect(
      activationClient.activate.mock.calls.filter(
        ([input]) => input.kind === "turn",
      ),
    ).toHaveLength(4);
  });

  test("invalidates cached Host resolution through the service-authenticated control path", async () => {
    const first = await startUpstream((_request, response) =>
      response.end("first"),
    );
    const second = await startUpstream((_request, response) =>
      response.end("second"),
    );
    const routes = [route({ hostPort: first.port })];
    const app = createGatewayApp(repository(routes), {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      internalServiceToken: "service-secret",
      routeCacheTtlMs: 60_000,
    });

    await expect(
      (
        await app.request("http://p-alpha.agent.localhost/", {
          headers: { host: "p-alpha.agent.localhost" },
        })
      ).text(),
    ).resolves.toBe("first");
    routes.splice(0, 1, route({ hostPort: second.port }));
    await expect(
      (
        await app.request("http://p-alpha.agent.localhost/", {
          headers: { host: "p-alpha.agent.localhost" },
        })
      ).text(),
    ).resolves.toBe("first");
    const invalidate = await app.request(
      "http://gateway/internal/cache/invalidate",
      {
        method: "POST",
        headers: {
          authorization: "Bearer service-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ hostname: "p-alpha.agent.localhost" }),
      },
    );
    expect(invalidate.status).toBe(200);
    await expect(
      (
        await app.request("http://p-alpha.agent.localhost/", {
          headers: { host: "p-alpha.agent.localhost" },
        })
      ).text(),
    ).resolves.toBe("second");
  });

  test("accepts credential envelopes only on the service-authenticated Playground path", async () => {
    const requests: Array<{
      host: string;
      authorization: string;
      envelope: string;
    }> = [];
    const upstream = await startUpstream((request, response) => {
      requests.push({
        host: request.headers.host ?? "",
        authorization: request.headers.authorization ?? "",
        envelope: String(request.headers[AGENT_AUTH_ENVELOPE_HEADER] ?? ""),
      });
      response.writeHead(202, {
        "content-type": "application/json",
        "x-eve-session-id": `eve_${requests.length}`,
      });
      response.end(JSON.stringify({ sessionId: `eve_${requests.length}` }));
    });
    const app = createGatewayApp(
      repository([route({ hostPort: upstream.port })]),
      {
        allowedBaseDomains: ["agent.localhost"],
        affinitySecret,
        internalServiceToken: "service-secret",
      },
    );
    const canonical = encodeAgentAuthEnvelope({
      version: 1,
      authority: "canonical",
      headers: [["authorization", "Bearer agent-token"]],
    });
    const local = encodeAgentAuthEnvelope({
      version: 1,
      authority: "loopback",
      headers: [],
    });

    const forged = await app.request(
      "http://gateway/internal/projects/proj_1/playground/eve/v1/session",
      {
        method: "POST",
        headers: {
          [AGENT_AUTH_ENVELOPE_HEADER]: canonical,
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: "forged" }),
      },
    );
    const canonicalResponse = await app.request(
      "http://gateway/internal/projects/proj_1/playground/eve/v1/session",
      {
        method: "POST",
        headers: {
          authorization: "Bearer service-secret",
          [AGENT_AUTH_ENVELOPE_HEADER]: canonical,
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: "canonical" }),
      },
    );
    const localResponse = await app.request(
      "http://gateway/internal/projects/proj_1/playground/eve/v1/session",
      {
        method: "POST",
        headers: {
          authorization: "Bearer service-secret",
          [AGENT_AUTH_ENVELOPE_HEADER]: local,
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: "local" }),
      },
    );
    const malformed = await app.request(
      "http://gateway/internal/projects/proj_1/playground/eve/v1/session",
      {
        method: "POST",
        headers: {
          authorization: "Bearer service-secret",
          [AGENT_AUTH_ENVELOPE_HEADER]: "malformed",
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: "malformed" }),
      },
    );

    expect(forged.status).toBe(404);
    expect(canonicalResponse.status).toBe(202);
    expect(localResponse.status).toBe(202);
    expect(malformed.status).toBe(400);
    expect(requests).toEqual([
      {
        host: "p-alpha.agent.localhost",
        authorization: "Bearer agent-token",
        envelope: "",
      },
      { host: `localhost:${upstream.port}`, authorization: "", envelope: "" },
    ]);
  });
});
