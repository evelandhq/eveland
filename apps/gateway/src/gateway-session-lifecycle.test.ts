import type { SessionBinding } from "@evelandhq/core/contracts";
import { PLAYGROUND_MAX_TRANSPORT_BYTES } from "@evelandhq/core/eve";
import { describe, expect, test, vi } from "vitest";
import {
  applyGatewaySessionResponse,
  resolveGatewaySessionBinding,
  type GatewaySessionBindingRepository,
} from "./gateway-session-lifecycle.js";

const activeBinding: SessionBinding = {
  id: "bind_1",
  projectId: "proj_1",
  eveSessionId: "eve_1",
  continuationToken: "continue_1",
  routeId: "route_1",
  deploymentId: "dep_1",
  trigger: "api",
  variantName: null,
  experimentId: null,
  requestId: "request_1",
  remoteIp: null,
  affinityFingerprint: null,
  affinitySource: null,
  createdAt: "2026-07-28T10:00:00.000Z",
  updatedAt: "2026-07-28T10:00:00.000Z",
};

function repositoryFixture(
  input: {
    bySession?: SessionBinding | null;
    byToken?: SessionBinding | null;
    touched?: SessionBinding | null;
  } = {},
) {
  const located = input.bySession ?? input.byToken ?? null;
  return {
    findSessionBinding: vi.fn(async () => input.bySession ?? null),
    findSessionBindingByContinuationToken: vi.fn(async () => input.byToken ?? null),
    touchSessionBinding: vi.fn(async () => (input.touched === undefined ? located : input.touched)),
    bindSession: vi.fn(async () => undefined),
    setSessionBindingContinuationToken: vi.fn(async () => activeBinding),
  } satisfies GatewaySessionBindingRepository;
}

const bufferedJson = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe("Gateway SessionBinding lifecycle", () => {
  test("resolves and refreshes a path SessionBinding", async () => {
    const repository = repositoryFixture({ bySession: activeBinding });
    const now = new Date("2026-07-28T12:00:00.000Z");
    const clock = vi.fn(() => {
      expect(repository.findSessionBinding).toHaveBeenCalledOnce();
      return now;
    });

    const resolution = await resolveGatewaySessionBinding({
      repository,
      projectId: "proj_1",
      request: { kind: "continuation", sessionId: "eve_1" },
      bufferedBody: undefined,
      now: clock,
      idlePolicy: { apiIdleTtlMs: 86_400_000 },
    });

    expect(resolution).toEqual({
      state: "active",
      lookup: "session_id",
      request: { kind: "continuation", sessionId: "eve_1" },
      binding: activeBinding,
    });
    expect(repository.findSessionBinding).toHaveBeenCalledWith("proj_1", "eve_1");
    expect(repository.findSessionBindingByContinuationToken).not.toHaveBeenCalled();
    expect(repository.touchSessionBinding).toHaveBeenCalledWith("proj_1", "eve_1", now);
    expect(clock).toHaveBeenCalledOnce();
  });

  test("resolves an initial or reset request by its buffered continuation token", async () => {
    const repository = repositoryFixture({ byToken: activeBinding });

    const resolution = await resolveGatewaySessionBinding({
      repository,
      projectId: "proj_1",
      request: { kind: "reset", sessionId: null },
      bufferedBody: bufferedJson({ continuationToken: "continue_1" }),
      now: () => new Date("2026-07-28T12:00:00.000Z"),
      idlePolicy: { apiIdleTtlMs: 86_400_000 },
    });

    expect(resolution).toMatchObject({
      state: "active",
      lookup: "continuation_token",
      binding: activeBinding,
    });
    expect(repository.findSessionBindingByContinuationToken).toHaveBeenCalledWith(
      "proj_1",
      "continue_1",
    );
  });

  test("does not read the idle clock when no binding lookup is needed", async () => {
    const repository = repositoryFixture();
    const clock = vi.fn(() => new Date());

    const resolution = await resolveGatewaySessionBinding({
      repository,
      projectId: "proj_1",
      request: null,
      bufferedBody: undefined,
      now: clock,
      idlePolicy: {},
    });

    expect(resolution).toEqual({
      state: "unbound",
      lookup: "none",
      request: null,
      binding: null,
    });
    expect(clock).not.toHaveBeenCalled();
  });

  test.each([
    {
      reason: "is past its idle TTL",
      binding: { ...activeBinding, updatedAt: "2026-07-27T10:00:00.000Z" },
      touched: activeBinding,
    },
    {
      reason: "disappears while being touched",
      binding: activeBinding,
      touched: null,
    },
  ])("reports a binding as expired when it $reason", async ({ binding, touched }) => {
    const repository = repositoryFixture({ bySession: binding, touched });

    const resolution = await resolveGatewaySessionBinding({
      repository,
      projectId: "proj_1",
      request: { kind: "continuation", sessionId: "eve_1" },
      bufferedBody: undefined,
      now: () => new Date("2026-07-28T12:00:00.000Z"),
      idlePolicy: { apiIdleTtlMs: 3_600_000 },
    });

    expect(resolution).toMatchObject({
      state: "expired",
      lookup: "session_id",
      binding,
    });
  });

  test("binds a successful initial response from its Eve header without reading a non-JSON body", async () => {
    const repository = repositoryFixture();
    const upstream = new Response("accepted", {
      status: 202,
      headers: { "x-eve-session-id": "eve_created" },
    });
    const clone = vi.spyOn(upstream, "clone");

    await applyGatewaySessionResponse({
      repository,
      projectId: "proj_1",
      request: { kind: "initial", sessionId: null },
      binding: null,
      upstream,
      target: {
        routeId: "route_1",
        deploymentId: "dep_1",
        variantName: "candidate",
        experimentId: "route_1:r2",
      },
      provenance: {
        kind: "api",
        requestId: "request_created",
        remoteIp: "203.0.113.7",
        affinity: {
          fingerprint: "sha256-affinity",
          source: "version_key",
        },
      },
    });

    expect(clone).not.toHaveBeenCalled();
    expect(repository.bindSession).toHaveBeenCalledWith({
      projectId: "proj_1",
      eveSessionId: "eve_created",
      continuationToken: null,
      routeId: "route_1",
      deploymentId: "dep_1",
      trigger: "api",
      variantName: "candidate",
      experimentId: "route_1:r2",
      requestId: "request_created",
      remoteIp: "203.0.113.7",
      affinityFingerprint: "sha256-affinity",
      affinitySource: "version_key",
    });
  });

  test("never clones a response whose declared length exceeds the metadata cap, and still binds from the Eve header", async () => {
    const repository = repositoryFixture();
    const upstream = new Response("{", {
      status: 202,
      headers: {
        "content-type": "application/json",
        "content-length": String(PLAYGROUND_MAX_TRANSPORT_BYTES + 1),
        "x-eve-session-id": "eve_big",
      },
    });
    const clone = vi.spyOn(upstream, "clone");

    await applyGatewaySessionResponse({
      repository,
      projectId: "proj_1",
      request: { kind: "initial", sessionId: null },
      binding: null,
      upstream,
      target: {
        routeId: "route_1",
        deploymentId: "dep_1",
        variantName: null,
        experimentId: null,
      },
      provenance: { kind: "playground", requestId: "request_big" },
    });

    expect(clone).not.toHaveBeenCalled();
    expect(repository.bindSession).toHaveBeenCalledWith(
      expect.objectContaining({
        eveSessionId: "eve_big",
        continuationToken: null,
      }),
    );
  });

  test("stops reading agent-controlled metadata at the byte cap and leaves the binding untouched", async () => {
    const repository = repositoryFixture();
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    // Well past the cap: an uncapped tee would pull every one of these bytes
    // into memory before giving up on the JSON parse.
    const total = PLAYGROUND_MAX_TRANSPORT_BYTES + 16 * chunk.byteLength;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= total) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        sent += chunk.byteLength;
      },
    });
    const upstream = new Response(body, {
      status: 202,
      headers: { "content-type": "application/json" },
    });

    await applyGatewaySessionResponse({
      repository,
      projectId: "proj_1",
      request: { kind: "continuation", sessionId: "eve_1" },
      binding: activeBinding,
      upstream,
      target: {
        routeId: "route_1",
        deploymentId: "dep_1",
        variantName: null,
        experimentId: null,
      },
      provenance: { kind: "playground", requestId: "request_flood" },
    });

    expect(sent).toBeLessThan(total);
    expect(repository.setSessionBindingContinuationToken).not.toHaveBeenCalled();
  });

  test.each([
    {
      request: { kind: "continuation" as const, sessionId: "eve_1" },
      body: { sessionId: "eve_1", continuationToken: "continue_2" },
      expectedToken: "continue_2",
    },
    {
      request: { kind: "reset" as const, sessionId: null },
      body: { ok: true, previousSessionId: "eve_1", status: "reset" },
      expectedToken: null,
    },
  ])("persists a successful $request.kind response", async ({ request, body, expectedToken }) => {
    const repository = repositoryFixture();

    await applyGatewaySessionResponse({
      repository,
      projectId: "proj_1",
      request,
      binding: activeBinding,
      upstream: Response.json(body, { status: 202 }),
      target: {
        routeId: "route_1",
        deploymentId: "dep_1",
        variantName: null,
        experimentId: null,
      },
      provenance: { kind: "playground", requestId: "request_playground" },
    });

    expect(repository.setSessionBindingContinuationToken).toHaveBeenCalledWith(
      "proj_1",
      "eve_1",
      expectedToken,
    );
  });

  test.each([
    {
      reason: "the upstream failed",
      request: { kind: "initial" as const, sessionId: null },
      response: Response.json({ sessionId: "eve_ignored" }, { status: 500 }),
    },
    {
      reason: "the request is a stream",
      request: { kind: "stream" as const, sessionId: "eve_1" },
      response: Response.json({ continuationToken: "continue_ignored" }),
    },
    {
      reason: "reset ownership does not match",
      request: { kind: "reset" as const, sessionId: null },
      response: Response.json({
        previousSessionId: "eve_other",
        status: "reset",
      }),
    },
  ])("does not mutate bindings when $reason", async ({ request, response }) => {
    const repository = repositoryFixture();
    const clone = vi.spyOn(response, "clone");

    await applyGatewaySessionResponse({
      repository,
      projectId: "proj_1",
      request,
      binding: activeBinding,
      upstream: response,
      target: {
        routeId: "route_1",
        deploymentId: "dep_1",
        variantName: null,
        experimentId: null,
      },
      provenance: { kind: "playground", requestId: "request_playground" },
    });

    expect(repository.bindSession).not.toHaveBeenCalled();
    expect(repository.setSessionBindingContinuationToken).not.toHaveBeenCalled();
    if (!response.ok || request.kind === "stream") {
      expect(clone).not.toHaveBeenCalled();
    }
  });
});
