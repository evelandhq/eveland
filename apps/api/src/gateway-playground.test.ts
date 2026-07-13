import { describe, expect, test, vi } from "vitest";
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
});
