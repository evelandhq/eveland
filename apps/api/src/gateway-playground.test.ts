import { describe, expect, test, vi } from "vitest";
import * as GatewayPlayground from "./gateway-playground.js";
import { runGatewayPlayground } from "./gateway-playground.js";

describe("Gateway Playground client", () => {
  test("uses the service-authenticated internal Gateway path and replays returned events", async () => {
    const fetchImplementation = vi.fn(async () =>
      Response.json({
        response: "Gateway answer",
        eveSessionId: "eve_1",
        continuationToken: "continue_1",
        events: [{ type: "turn.completed", payload: { turnId: "turn_0" } }],
      }),
    );
    const onEvent = vi.fn(async () => undefined);

    const result = await runGatewayPlayground(
      {
        project: { id: "proj_1" } as never,
        deployment: { id: "dep_1" } as never,
        message: "hello",
        onEvent,
      },
      { gatewayUrl: "http://gateway:4080", serviceToken: "service-secret", fetchImplementation },
    );

    expect(fetchImplementation).toHaveBeenCalledWith(
      "http://gateway:4080/internal/projects/proj_1/playground",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer service-secret" }),
        body: JSON.stringify({ message: "hello" }),
      }),
    );
    expect(onEvent).toHaveBeenCalledWith({ type: "turn.completed", payload: { turnId: "turn_0" } });
    expect(result).toMatchObject({ response: "Gateway answer", eveSessionId: "eve_1", events: [] });
  });

  test("proxies canonical Eve requests without buffering the response stream", async () => {
    const proxy = (GatewayPlayground as Record<string, unknown>).proxyGatewayPlayground;
    expect(proxy).toBeTypeOf("function");
    if (typeof proxy !== "function") return;
    const fetchImplementation = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response('{"type":"message.appended"}\n', {
        status: 200,
        headers: {
          "content-type": "application/x-ndjson",
          "x-eve-stream-tail-index": "2",
        },
      }),
    );
    const response = await proxy(
      {
        projectId: "proj_1",
        path: "/eve/v1/session/eve_1/stream?startIndex=2&includeTailIndex=1",
        method: "GET",
        headers: new Headers({ accept: "application/x-ndjson", cookie: "must-not-forward=1" }),
        body: null,
      },
      { gatewayUrl: "http://gateway:4080", serviceToken: "service-secret", fetchImplementation },
    );

    expect(fetchImplementation).toHaveBeenCalledWith(
      "http://gateway:4080/internal/projects/proj_1/playground/eve/v1/session/eve_1/stream?startIndex=2&includeTailIndex=1",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ authorization: "Bearer service-secret", accept: "application/x-ndjson" }),
      }),
    );
    expect((fetchImplementation.mock.calls[0]?.[1]?.headers as Record<string, string>).cookie).toBeUndefined();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-eve-stream-tail-index")).toBe("2");
    await expect(response.text()).resolves.toContain("message.appended");
  });
});
