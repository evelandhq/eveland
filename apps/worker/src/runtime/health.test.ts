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

    await expect(waitForHttpHealth({ host: "127.0.0.1", port, timeoutMs: 700 })).rejects.toThrow(/did not respond within 700ms/);
  });
});
