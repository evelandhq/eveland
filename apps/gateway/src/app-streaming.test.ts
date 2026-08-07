import { request as httpRequest } from "node:http";
import { serve } from "@hono/node-server";
import { describe, expect, test, vi } from "vitest";
import { createGatewayApp } from "./app.js";
import { affinityBucketForRoute } from "@evelandhq/core/routing";
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
  test("forwards Eve's leading NDJSON whitespace without waiting for the first event", async () => {
    let markClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    const upstream = await startUpstream((_request, response) => {
      response.once("close", markClosed);
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write("\n");
      setTimeout(() => response.write('{"type":"turn.started"}\n'), 50);
      setTimeout(() => response.end('{"type":"turn.completed"}\n'), 250);
    });
    const app = createGatewayApp(repository([route({ hostPort: upstream.port })]), {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
    });
    const startedAt = Date.now();
    const response = await app.request(
      "http://p-alpha.agent.localhost/eve/v1/session/eve_1/stream",
      {
        headers: { host: "p-alpha.agent.localhost:4080" },
      },
    );
    const reader = response.body!.getReader();
    const first = await reader.read();

    expect(new TextDecoder().decode(first.value)).toBe("\n");
    expect(Date.now() - startedAt).toBeLessThan(200);
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toContain("turn.started");
    await reader.cancel();
    await expect(
      Promise.race([
        closed,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("upstream stream stayed open")), 200),
        ),
      ]),
    ).resolves.toBeUndefined();
  });

  test("preserves Eve 0.27.7 bounded stream query and durable tail header", async () => {
    let upstreamPath: string | undefined;
    const upstream = await startUpstream((request, response) => {
      upstreamPath = request.url;
      response.writeHead(200, {
        "content-type": "application/x-ndjson",
        "x-eve-stream-tail-index": "2",
      });
      response.end('{"type":"session.waiting"}\n');
    });
    const app = createGatewayApp(repository([route({ hostPort: upstream.port })]), {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
    });

    const response = await app.request(
      "http://p-alpha.agent.localhost/eve/v1/session/eve_1/stream?startIndex=1&includeTailIndex=1",
      {
        headers: { host: "p-alpha.agent.localhost:4080" },
      },
    );

    expect(upstreamPath).toBe("/eve/v1/session/eve_1/stream?startIndex=1&includeTailIndex=1");
    expect(response.headers.get("x-eve-stream-tail-index")).toBe("2");
    await expect(response.text()).resolves.toContain("session.waiting");
  });

  test("passes through a custom channel method, query, headers, and body", async () => {
    const upstream = await startUpstream((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            method: request.method,
            path: request.url,
            contentType: request.headers["content-type"],
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      });
    });
    const app = createGatewayApp(repository([route({ hostPort: upstream.port })]), {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
    });

    const response = await app.request(
      "http://p-alpha.agent.localhost/channels/slack/events?team=T1",
      {
        method: "POST",
        headers: {
          host: "p-alpha.agent.localhost",
          "content-type": "application/json",
        },
        body: JSON.stringify({ event: "message" }),
      },
    );

    await expect(response.json()).resolves.toEqual({
      method: "POST",
      path: "/channels/slack/events?team=T1",
      contentType: "application/json",
      body: JSON.stringify({ event: "message" }),
    });
  });

  test("writes an initial SessionBinding and uses it for continuation and workflow paths", async () => {
    const upstream = await startUpstream((request, response) => {
      if (request.url === "/eve/v1/session" && request.method === "POST") {
        response.writeHead(202, {
          "content-type": "application/json",
          "x-eve-session-id": "eve_bound",
        });
        response.end(JSON.stringify({ sessionId: "eve_bound" }));
        return;
      }
      response.end(`proxied:${request.url}`);
    });
    const repo = repository([route({ hostPort: upstream.port })]);
    const app = createGatewayApp(repo, {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
    });

    const create = await app.request("http://p-alpha.agent.localhost/eve/v1/session", {
      method: "POST",
      headers: {
        host: "p-alpha.agent.localhost:4080",
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "hello" }),
    });
    const continuation = await app.request(
      "http://p-alpha.agent.localhost/eve/v1/session/eve_bound",
      {
        method: "POST",
        headers: { host: "p-alpha.agent.localhost:4080" },
      },
    );
    const workflow = await app.request(
      "http://p-alpha.agent.localhost/.well-known/workflow/v1/flow",
      {
        headers: { host: "p-alpha.agent.localhost:4080" },
      },
    );

    expect(create.status).toBe(202);
    expect(repo.bindings).toEqual([
      expect.objectContaining({
        eveSessionId: "eve_bound",
        routeId: "route_project",
        deploymentId: "dep_1",
      }),
    ]);
    await expect(continuation.text()).resolves.toBe("proxied:/eve/v1/session/eve_bound");
    // This assertion used to expect the request to be proxied. eve's Workflow
    // queue handler authenticates nothing beyond three `x-vqs-*` headers, so
    // proxying it meant anyone who could reach a project's public hostname could
    // drive that project's workflow and step invocations.
    expect(workflow.status).toBe(404);
  });

  test("refuses the Workflow step route without ever reaching the Agent", async () => {
    let upstreamHits = 0;
    const upstream = await startUpstream((_request, response) => {
      upstreamHits += 1;
      response.end("should not be reached");
    });
    const repo = repository([route({ hostPort: upstream.port })]);
    const app = createGatewayApp(repo, {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
    });

    for (const path of ["/.well-known/workflow/v1/flow", "/.well-known/workflow/v1/step"]) {
      const response = await app.request(`http://p-alpha.agent.localhost${path}`, {
        method: "POST",
        headers: {
          host: "p-alpha.agent.localhost:4080",
          // The headers eve's handler looks for: refusing before they are even
          // read is the point.
          "x-vqs-queue-name": "__wkf_workflow_greet",
          "x-vqs-message-id": "msg_forged",
          "x-vqs-message-attempt": "1",
        },
        body: JSON.stringify({ runId: "wrun_forged" }),
      });
      expect(response.status, path).toBe(404);
    }
    expect(upstreamHits).toBe(0);
  });

  test("returns 410 instead of routing an expired public API SessionBinding", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.end("should not be reached");
    });
    const repo = repository([route({ hostPort: upstream.port })]);
    repo.bindings.push({
      id: "bind_expired_api",
      projectId: "proj_1",
      eveSessionId: "eve_expired_api",
      continuationToken: "continue_expired_api",
      routeId: "route_project",
      deploymentId: "dep_1",
      trigger: "api",
      variantName: null,
      experimentId: null,
      requestId: "request_expired_api",
      remoteIp: null,
      affinityFingerprint: null,
      affinitySource: null,
      createdAt: "2026-07-20T12:00:00.000Z",
      updatedAt: "2026-07-20T12:00:00.000Z",
    });
    const app = createGatewayApp(repo, {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      now: () => new Date("2026-07-28T12:00:00.000Z"),
      apiSessionIdleTtlMs: 604_800_000,
    });

    const response = await app.request(
      "http://p-alpha.agent.localhost/eve/v1/session/eve_expired_api",
      {
        method: "POST",
        headers: { host: "p-alpha.agent.localhost" },
      },
    );

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({
      error: "Session expired",
      code: "session_expired",
    });
  });

  test("refreshes a live binding before activating its continuation", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ sessionId: "eve_live_api" }));
    });
    const repo = repository([route({ hostPort: upstream.port, deploymentStatus: "stopped" })]);
    repo.bindings.push({
      id: "bind_live_api",
      projectId: "proj_1",
      eveSessionId: "eve_live_api",
      continuationToken: "continue_live_api",
      routeId: "route_project",
      deploymentId: "dep_1",
      trigger: "api",
      variantName: null,
      experimentId: null,
      requestId: "request_live_api",
      remoteIp: null,
      affinityFingerprint: null,
      affinitySource: null,
      createdAt: "2026-07-28T10:00:00.000Z",
      updatedAt: "2026-07-28T10:00:00.000Z",
    });
    const activationClient = {
      activate: vi.fn(async () => ({
        leaseId: "lease_live_api",
        endpointPort: upstream.port,
      })),
      renew: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    };
    const now = new Date("2026-07-28T12:00:00.000Z");
    const app = createGatewayApp(repo, {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      activationClient,
      now: () => now,
    });

    const response = await app.request(
      "http://p-alpha.agent.localhost/eve/v1/session/eve_live_api",
      {
        method: "POST",
        headers: { host: "p-alpha.agent.localhost" },
      },
    );

    expect(response.status).toBe(202);
    expect(repo.bindings[0]).toMatchObject({ updatedAt: now.toISOString() });
    expect(activationClient.activate).toHaveBeenCalledOnce();
  });

  test.each([
    {
      operation: "continuation",
      path: "/eve/v1/session/eve_persist_api",
      body: JSON.stringify({ message: "continue" }),
      response: {
        sessionId: "eve_persist_api",
        continuationToken: "continue_next_api",
      },
      expectedToken: "continue_next_api",
    },
    {
      operation: "reset",
      path: "/eve/v1/session/reset",
      body: JSON.stringify({ continuationToken: "continue_current_api" }),
      response: {
        ok: true,
        previousSessionId: "eve_persist_api",
        status: "reset",
      },
      expectedToken: null,
    },
  ])(
    "cleans up an activated public upstream when $operation binding persistence fails",
    async ({ path, body, response: responseBody, expectedToken }) => {
      const { repo, activationClient, persistenceError } =
        await activatedSessionPersistenceFailureFixture({
          trigger: "api",
          eveSessionId: "eve_persist_api",
          continuationToken: "continue_current_api",
          leaseId: "lease_persist_api",
          responseBody,
        });
      const cancel = vi.spyOn(ReadableStream.prototype, "cancel");
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const app = createGatewayApp(repo, {
        allowedBaseDomains: ["agent.localhost"],
        affinitySecret,
        activationClient,
        now: () => new Date("2026-07-28T12:00:00.000Z"),
      });

      try {
        const result = await app.request(`http://p-alpha.agent.localhost${path}`, {
          method: "POST",
          headers: {
            host: "p-alpha.agent.localhost",
            "content-type": "application/json",
          },
          body,
        });

        expect(result.status).toBe(500);
        expect(repo.setSessionBindingContinuationToken).toHaveBeenCalledWith(
          "proj_1",
          "eve_persist_api",
          expectedToken,
        );
        expect(cancel).toHaveBeenCalledWith(persistenceError);
        expect(activationClient.release).toHaveBeenCalledTimes(1);
        expect(activationClient.release).toHaveBeenCalledWith("lease_persist_api");
      } finally {
        cancel.mockRestore();
        errorLog.mockRestore();
      }
    },
  );

  test("keeps bindings pinned across 90/10 to 50/50 and weight-zero policy changes", async () => {
    let firstSequence = 0;
    const first = await startUpstream((_request, response) => {
      const sessionId = `eve_a_${++firstSequence}`;
      response.writeHead(202, {
        "content-type": "application/json",
        "x-eve-session-id": sessionId,
      });
      response.end(JSON.stringify({ deployment: "a", sessionId }));
    });
    const second = await startUpstream((_request, response) => {
      response.writeHead(202, {
        "content-type": "application/json",
        "x-eve-session-id": "eve_weighted",
      });
      response.end(JSON.stringify({ deployment: "b", sessionId: "eve_weighted" }));
    });
    const weighted = route({
      targets: [
        {
          routeId: "route_project",
          deploymentId: "dep_a",
          weight: 9_000,
          variantName: "control",
          hostPort: first.port,
          status: "running",
        },
        {
          routeId: "route_project",
          deploymentId: "dep_b",
          weight: 1_000,
          variantName: "candidate",
          hostPort: second.port,
          status: "running",
        },
      ],
    });
    const repo = repository([weighted]);
    const app = createGatewayApp(repo, {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      routeCacheTtlMs: 0,
    });
    const affinity = Array.from({ length: 10_000 }, (_, index) => `bucket-${index}`).find(
      (key) => affinityBucketForRoute(weighted.id, weighted.policyRevision, key) >= 9_000,
    )!;
    const initial = await app.request("http://p-alpha.agent.localhost/eve/v1/session", {
      method: "POST",
      headers: {
        host: "p-alpha.agent.localhost",
        "x-eveland-version-key": affinity,
        "content-type": "application/json",
      },
      body: "{}",
    });
    await expect(initial.json()).resolves.toMatchObject({ deployment: "b" });
    expect(repo.bindings).toContainEqual(
      expect.objectContaining({
        eveSessionId: "eve_weighted",
        deploymentId: "dep_b",
        experimentId: "route_project:r1",
      }),
    );

    weighted.policyRevision = 2;
    weighted.targets = [
      {
        routeId: "route_project",
        deploymentId: "dep_a",
        weight: 5_000,
        variantName: "control",
        hostPort: first.port,
        status: "running",
      },
      {
        routeId: "route_project",
        deploymentId: "dep_b",
        weight: 5_000,
        variantName: "candidate",
        hostPort: second.port,
        status: "running",
      },
    ];
    const continuation = await app.request(
      "http://p-alpha.agent.localhost/eve/v1/session/eve_weighted",
      {
        method: "POST",
        headers: {
          host: "p-alpha.agent.localhost",
          "x-eveland-version-key": affinity,
        },
      },
    );
    await expect(continuation.json()).resolves.toMatchObject({
      deployment: "b",
    });

    weighted.policyRevision = 3;
    weighted.targets = [
      {
        routeId: "route_project",
        deploymentId: "dep_a",
        weight: 10_000,
        variantName: "control",
        hostPort: first.port,
        status: "running",
      },
      {
        routeId: "route_project",
        deploymentId: "dep_b",
        weight: 0,
        variantName: "candidate",
        hostPort: second.port,
        status: "running",
      },
    ];
    const afterZero = await app.request("http://p-alpha.agent.localhost/eve/v1/session", {
      method: "POST",
      headers: {
        host: "p-alpha.agent.localhost",
        "x-eveland-version-key": affinity,
        "content-type": "application/json",
      },
      body: "{}",
    });
    await expect(afterZero.json()).resolves.toMatchObject({ deployment: "a" });
    const pinnedAfterZero = await app.request(
      "http://p-alpha.agent.localhost/eve/v1/session/eve_weighted",
      {
        method: "POST",
        headers: { host: "p-alpha.agent.localhost" },
      },
    );
    await expect(pinnedAfterZero.json()).resolves.toMatchObject({
      deployment: "b",
    });
    const cancelAfterZero = await app.request(
      "http://p-alpha.agent.localhost/eve/v1/session/eve_weighted/cancel",
      {
        method: "POST",
        headers: {
          host: "p-alpha.agent.localhost",
          "content-type": "application/json",
        },
        body: JSON.stringify({ turnId: "turn_weighted" }),
      },
    );
    await expect(cancelAfterZero.json()).resolves.toMatchObject({
      deployment: "b",
    });
    expect(repo.bindings).toContainEqual(
      expect.objectContaining({
        deploymentId: "dep_b",
        variantName: "candidate",
        experimentId: "route_project:r1",
        affinitySource: "version_key",
        affinityFingerprint: expect.stringMatching(/^sha256-[a-f0-9]{64}$/),
      }),
    );
    expect(repo.bindings).toContainEqual(
      expect.objectContaining({
        eveSessionId: "eve_a_1",
        deploymentId: "dep_a",
        experimentId: "route_project:r3",
      }),
    );
  });

  test("pins create-by-token and session reset to the continuation token owner", async () => {
    const selected: string[] = [];
    const first = await startUpstream(async (request, response) => {
      selected.push(`a:${request.url}`);
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          deployment: "a",
          ok: true,
          sessionId: "eve_from_a",
          continuationToken: "continue_reset",
          status: request.url === "/eve/v1/session/reset" ? "no_active_session" : undefined,
        }),
      );
    });
    const second = await startUpstream(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      selected.push(`b:${request.url}`);
      response.setHeader("content-type", "application/json");
      if (request.url === "/eve/v1/session/reset") {
        response.end(
          JSON.stringify({
            deployment: "b",
            ok: true,
            previousSessionId: "eve_reset_owner",
            status: "reset",
          }),
        );
        return;
      }
      response.end(
        JSON.stringify({
          deployment: "b",
          ok: true,
          sessionId: "eve_reset_owner",
          continuationToken: "continue_reset",
        }),
      );
    });
    const weighted = route({
      targets: [
        {
          routeId: "route_project",
          deploymentId: "dep_a",
          weight: 9_000,
          variantName: "control",
          hostPort: first.port,
          status: "running",
        },
        {
          routeId: "route_project",
          deploymentId: "dep_b",
          weight: 1_000,
          variantName: "candidate",
          hostPort: second.port,
          status: "running",
        },
      ],
    });
    const affinity = Array.from({ length: 10_000 }, (_, index) => `reset-bucket-${index}`).find(
      (key) => affinityBucketForRoute(weighted.id, weighted.policyRevision, key) >= 9_000,
    )!;
    const repo = repository([weighted]);
    const app = createGatewayApp(repo, {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      routeCacheTtlMs: 0,
    });

    const initial = await app.request("http://p-alpha.agent.localhost/eve/v1/session", {
      method: "POST",
      headers: {
        host: "p-alpha.agent.localhost",
        "content-type": "application/json",
        "x-eveland-version-key": affinity,
      },
      body: JSON.stringify({ message: "first" }),
    });
    await expect(initial.json()).resolves.toMatchObject({ deployment: "b" });
    expect(repo.bindings).toContainEqual(
      expect.objectContaining({
        eveSessionId: "eve_reset_owner",
        continuationToken: "continue_reset",
        deploymentId: "dep_b",
      }),
    );

    weighted.policyRevision = 2;
    weighted.targets = [
      {
        routeId: "route_project",
        deploymentId: "dep_a",
        weight: 10_000,
        variantName: "control",
        hostPort: first.port,
        status: "running",
      },
      {
        routeId: "route_project",
        deploymentId: "dep_b",
        weight: 0,
        variantName: "candidate",
        hostPort: second.port,
        status: "running",
      },
    ];

    const resumedCreate = await app.request("http://p-alpha.agent.localhost/eve/v1/session", {
      method: "POST",
      headers: {
        host: "p-alpha.agent.localhost",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        continuationToken: "continue_reset",
        message: "resume by token",
      }),
    });
    await expect(resumedCreate.json()).resolves.toMatchObject({ deployment: "b" });

    const reset = await app.request("http://p-alpha.agent.localhost/eve/v1/session/reset", {
      method: "POST",
      headers: {
        host: "p-alpha.agent.localhost",
        "content-type": "application/json",
      },
      body: JSON.stringify({ continuationToken: "continue_reset" }),
    });
    await expect(reset.json()).resolves.toMatchObject({
      deployment: "b",
      previousSessionId: "eve_reset_owner",
      status: "reset",
    });
    expect(selected.slice(-2)).toEqual(["b:/eve/v1/session", "b:/eve/v1/session/reset"]);
    expect(
      repo.bindings.find((binding) => binding.eveSessionId === "eve_reset_owner"),
    ).toMatchObject({ continuationToken: null });
  });

  test("issues and verifies a signed HttpOnly affinity cookie without storing the raw key", async () => {
    let sequence = 0;
    const selected: string[] = [];
    const makeUpstream = async (deployment: string) =>
      startUpstream((request, response) => {
        selected.push(deployment);
        response.writeHead(202, {
          "content-type": "application/json",
          "x-eve-session-id": `eve_${++sequence}`,
        });
        response.end(
          JSON.stringify({
            deployment,
            sessionId: `eve_${sequence}`,
            headers: request.headers,
          }),
        );
      });
    const first = await makeUpstream("a");
    const second = await makeUpstream("b");
    const weighted = route({
      targets: [
        {
          routeId: "route_project",
          deploymentId: "dep_a",
          weight: 5_000,
          variantName: "a",
          hostPort: first.port,
          status: "running",
        },
        {
          routeId: "route_project",
          deploymentId: "dep_b",
          weight: 5_000,
          variantName: "b",
          hostPort: second.port,
          status: "running",
        },
      ],
    });
    const repo = repository([weighted]);
    const app = createGatewayApp(repo, {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
    });

    const initial = await app.request("https://p-alpha.agent.localhost/eve/v1/session", {
      method: "POST",
      headers: {
        host: "p-alpha.agent.localhost",
        "content-type": "application/json",
      },
      body: "{}",
    });
    const affinityCookie = initial.headers
      .getSetCookie()
      .find((value) => value.startsWith("eveland_affinity="));
    expect(affinityCookie).toMatch(
      /; Domain=agent\.localhost; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
    );
    const cookiePair = affinityCookie!.split(";", 1)[0]!;

    const replay = await app.request("https://p-alpha.agent.localhost/eve/v1/session", {
      method: "POST",
      headers: {
        host: "p-alpha.agent.localhost",
        cookie: `${cookiePair}; app_session=user`,
        "content-type": "application/json",
      },
      body: "{}",
    });

    const replayBody = (await replay.json()) as {
      headers: Record<string, string>;
    };
    expect(
      replay.headers.getSetCookie().some((value) => value.startsWith("eveland_affinity=")),
    ).toBe(false);
    expect(replayBody.headers.cookie).toBe("app_session=user");
    expect(selected[1]).toBe(selected[0]);
    expect(repo.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          affinitySource: "generated",
          affinityFingerprint: expect.stringMatching(/^sha256-[a-f0-9]{64}$/),
        }),
        expect.objectContaining({
          affinitySource: "cookie",
          affinityFingerprint: expect.stringMatching(/^sha256-[a-f0-9]{64}$/),
        }),
      ]),
    );
    expect(JSON.stringify(repo.bindings)).not.toContain(cookiePair.split("=", 2)[1]);

    const [name, value] = cookiePair.split("=", 2);
    const base64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const trailingCharacterIndex = base64UrlAlphabet.indexOf(value!.at(-1)!);
    expect(trailingCharacterIndex).toBeGreaterThanOrEqual(0);
    expect(trailingCharacterIndex % 4).toBe(0);
    const equivalentTrailingCharacter = base64UrlAlphabet[trailingCharacterIndex + 1]!;
    const tampered = `${name}=${value!.slice(0, -1)}${equivalentTrailingCharacter}`;
    const rejectedTamper = await app.request("https://p-alpha.agent.localhost/eve/v1/session", {
      method: "POST",
      headers: {
        host: "p-alpha.agent.localhost",
        cookie: tampered,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(
      rejectedTamper.headers.getSetCookie().some((entry) => entry.startsWith("eveland_affinity=")),
    ).toBe(true);

    const malformed = await app.request("https://p-alpha.agent.localhost/eve/v1/session", {
      method: "POST",
      headers: {
        host: "p-alpha.agent.localhost",
        cookie: "eveland_affinity=%",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(malformed.status).toBe(202);
    expect(
      malformed.headers.getSetCookie().some((entry) => entry.startsWith("eveland_affinity=")),
    ).toBe(true);
  });

  test("rejects request bodies over the configured limit before proxying", async () => {
    let upstreamRequests = 0;
    const upstream = await startUpstream((_request, response) => {
      upstreamRequests += 1;
      response.end("unexpected");
    });
    const app = createGatewayApp(repository([route({ hostPort: upstream.port })]), {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      maxRequestBodyBytes: 4,
    });

    const response = await app.request("http://p-alpha.agent.localhost/custom-channel", {
      method: "POST",
      headers: {
        host: "p-alpha.agent.localhost",
        "content-type": "text/plain",
      },
      body: "12345",
    });

    expect(response.status).toBe(413);
    expect(upstreamRequests).toBe(0);
  });

  test("rejects a declared oversized body without waking a dormant deployment", async () => {
    const activationClient = {
      activate: vi.fn(async () => ({
        leaseId: "unexpected",
        endpointPort: 41999,
      })),
      renew: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    };
    const app = createGatewayApp(repository([route({ deploymentStatus: "stopped" })]), {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      maxRequestBodyBytes: 4,
      activationClient,
    });

    const response = await app.request("http://p-alpha.agent.localhost/custom-channel", {
      method: "POST",
      headers: {
        host: "p-alpha.agent.localhost",
        "content-type": "text/plain",
        "content-length": "5",
      },
      body: "12345",
    });

    expect(response.status).toBe(413);
    expect(activationClient.activate).not.toHaveBeenCalled();
  });

  test("cancels the upstream request promptly when the downstream signal aborts", async () => {
    let markStarted!: () => void;
    let markClosed!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    const upstream = await startUpstream((_request, response) => {
      markStarted();
      response.once("close", markClosed);
      setTimeout(() => response.end("late"), 500);
    });
    const app = createGatewayApp(repository([route({ hostPort: upstream.port })]), {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
    });
    const controller = new AbortController();
    const pending = app.request("http://p-alpha.agent.localhost/slow", {
      headers: { host: "p-alpha.agent.localhost" },
      signal: controller.signal,
    });
    await started;
    const abortedAt = Date.now();

    controller.abort();
    const response = await pending;

    expect(response.status).toBe(499);
    expect(Date.now() - abortedAt).toBeLessThan(200);
    await expect(
      Promise.race([
        closed,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("upstream stayed open")), 200),
        ),
      ]),
    ).resolves.toBeUndefined();
  });

  test("closes the upstream response when a real downstream socket disconnects", async () => {
    let markUpstreamClosed!: () => void;
    const upstreamClosed = new Promise<void>((resolve) => {
      markUpstreamClosed = resolve;
    });
    const upstream = await startUpstream((_request, response) => {
      response.once("close", markUpstreamClosed);
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write('{"type":"turn.started"}\n');
    });
    const app = createGatewayApp(repository([route({ hostPort: upstream.port })]), {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
    });
    const gateway = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    gatewayServers.push(gateway);
    if (!gateway.listening)
      await new Promise<void>((resolve) => gateway.once("listening", resolve));
    const address = gateway.address();
    if (!address || typeof address === "string") throw new Error("Gateway fixture did not bind.");

    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path: "/eve/v1/session/eve_1/stream",
          headers: { host: "p-alpha.agent.localhost" },
        },
        (response) => {
          response.once("data", () => {
            response.destroy();
            resolve();
          });
        },
      );
      request.once("error", reject);
      request.end();
    });

    await expect(
      Promise.race([
        upstreamClosed,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("upstream survived downstream disconnect")), 500),
        ),
      ]),
    ).resolves.toBeUndefined();
  });
});
