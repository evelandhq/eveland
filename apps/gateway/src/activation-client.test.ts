import { createServer } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { createApiActivationClient } from "./activation-client.js";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("createApiActivationClient", () => {
  test("authenticates activate, renew, and release calls to the control API", async () => {
    const requests: Array<{ method?: string; url?: string; authorization?: string; body: string }> =
      [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.setHeader("content-type", "application/json");
      response.end(
        request.method === "POST" && request.url === "/internal/runtime/activations"
          ? JSON.stringify({ lease: { id: "lease_api" }, runtimeInstance: { endpointPort: 41990 } })
          : JSON.stringify({ ok: true }),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected API fixture port.");
    const client = createApiActivationClient({
      apiUrl: `http://127.0.0.1:${address.port}`,
      serviceToken: "gateway-service-token",
    });

    await expect(
      client.activate(
        {
          deploymentId: "dep_wake",
          kind: "turn",
          ownerId: "req_wake",
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ leaseId: "lease_api", endpointPort: 41990 });
    await client.renew("lease_api");
    await client.release("lease_api");

    expect(requests).toEqual([
      expect.objectContaining({
        method: "POST",
        url: "/internal/runtime/activations",
        authorization: "Bearer gateway-service-token",
        body: JSON.stringify({ deploymentId: "dep_wake", kind: "turn", ownerId: "req_wake" }),
      }),
      expect.objectContaining({
        method: "POST",
        url: "/internal/runtime/activations/lease_api/renew",
      }),
      expect.objectContaining({ method: "DELETE", url: "/internal/runtime/activations/lease_api" }),
    ]);
  });

  test("carries the control API's rejection reason into the activation error", async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 504;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: "Runtime activation timed out after 30000ms." }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected API fixture port.");
    const client = createApiActivationClient({
      apiUrl: `http://127.0.0.1:${address.port}`,
      serviceToken: "gateway-service-token",
    });

    await expect(
      client.activate(
        { deploymentId: "dep_cold", kind: "turn", ownerId: "req_cold" },
        new AbortController().signal,
      ),
    ).rejects.toThrow(
      "Control API activation failed with HTTP 504: Runtime activation timed out after 30000ms.",
    );
  });

  test("retries while the previous RuntimeInstance is draining", async () => {
    let attempts = 0;
    const server = createServer((_request, response) => {
      attempts += 1;
      if (attempts === 1) {
        response.writeHead(425, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "RuntimeInstance is draining" }));
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          lease: { id: "lease_after_drain" },
          runtimeInstance: { endpointPort: 41990 },
        }),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected API fixture port.");
    const client = createApiActivationClient({
      apiUrl: `http://127.0.0.1:${address.port}`,
      serviceToken: "gateway-service-token",
      drainRetryMs: 1,
    });

    await expect(
      client.activate(
        {
          deploymentId: "dep_drain",
          kind: "public_request",
          ownerId: "req_after_drain",
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ leaseId: "lease_after_drain", endpointPort: 41990 });
    expect(attempts).toBe(2);
  });
});
