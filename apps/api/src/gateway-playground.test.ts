import { describe, expect, test, vi } from "vitest";
import * as GatewayPlayground from "./gateway-playground.js";

describe("Gateway Playground client", () => {
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
