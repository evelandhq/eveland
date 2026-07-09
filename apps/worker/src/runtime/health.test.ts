import { describe, expect, test } from "vitest";
import http from "node:http";
import { waitForHttpHealth } from "./health.js";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || !address) {
    throw new Error("Expected TCP address.");
  }
  return address.port;
}

describe("waitForHttpHealth", () => {
  test("resolves when the server answers, even with a non-200 status", async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 404;
      res.end("not found");
    });
    const port = await listen(server);

    try {
      await expect(waitForHttpHealth({ host: "127.0.0.1", port, timeoutMs: 2000 })).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  test("rejects with the last connection error when nothing listens", async () => {
    const server = http.createServer();
    const port = await listen(server);
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

    await expect(waitForHttpHealth({ host: "127.0.0.1", port, timeoutMs: 700 })).rejects.toThrow(
      /did not respond within 700ms.*ECONNREFUSED/s,
    );
  });

  test("rejects within a bounded time when the target accepts connections but never responds", async () => {
    const server = http.createServer(() => {
      // Intentionally never call res.end() / write a response: the connection
      // is accepted but the request hangs forever.
    });
    const port = await listen(server);

    try {
      const start = Date.now();
      await expect(waitForHttpHealth({ host: "127.0.0.1", port, timeoutMs: 700 })).rejects.toThrow();
      const elapsed = Date.now() - start;
      // Generous margin over the 700ms budget for scheduling jitter, but tight
      // enough to catch the unclamped-attempt bug (~1250ms observed pre-fix).
      expect(elapsed).toBeLessThan(1000);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  test("retries past initial connection failures and resolves once the target starts", async () => {
    const probe = http.createServer();
    const port = await listen(probe);
    await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));

    const healthPromise = waitForHttpHealth({ host: "127.0.0.1", port, timeoutMs: 5000 });

    await new Promise((resolve) => setTimeout(resolve, 400));

    const server = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

    try {
      await expect(healthPromise).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
