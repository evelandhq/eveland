import { describe, expect, test, vi } from "vitest";
import http from "node:http";
import { waitForHttpHealth, waitForOwnedHttpHealth } from "./health.js";
import type { PortOwnership } from "./types.js";

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
      await expect(
        waitForHttpHealth({ host: "127.0.0.1", port, timeoutMs: 2000 }),
      ).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test("rejects with the last connection error when nothing listens", async () => {
    const server = http.createServer();
    const port = await listen(server);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );

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
      await expect(
        waitForHttpHealth({ host: "127.0.0.1", port, timeoutMs: 700 }),
      ).rejects.toThrow();
      const elapsed = Date.now() - start;
      // Generous margin over the 700ms budget for scheduling jitter, but tight
      // enough to catch the unclamped-attempt bug (~1250ms observed pre-fix).
      expect(elapsed).toBeLessThan(1000);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test("retries past initial connection failures and resolves once the target starts", async () => {
    const probe = http.createServer();
    const port = await listen(probe);
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );

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
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

describe("waitForOwnedHttpHealth", () => {
  test("fails immediately and loudly when the port is held by a foreign process", async () => {
    const verifyPortOwnership = vi.fn(
      async (): Promise<PortOwnership> => ({
        status: "foreign",
        holder: "pid 9876 (unit eveland-proj_other-dep_9.service)",
      }),
    );
    const waitForHealth = vi.fn();

    const start = Date.now();
    await expect(
      waitForOwnedHttpHealth({
        host: "127.0.0.1",
        port: 41032,
        timeoutMs: 5000,
        processName: "eveland-proj_a-dep_1",
        runtime: { verifyPortOwnership },
        waitForHealth,
      }),
    ).rejects.toThrow(/eveland-proj_other-dep_9\.service/);
    // A foreign holder is a hard failure, not a condition to wait out.
    expect(Date.now() - start).toBeLessThan(1000);
    expect(waitForHealth).not.toHaveBeenCalled();
  });

  test("proceeds to the HTTP probe once the process owns its port", async () => {
    const verifyPortOwnership = vi.fn(async (): Promise<PortOwnership> => ({ status: "owned" }));
    const waitForHealth = vi.fn(async () => undefined);

    await expect(
      waitForOwnedHttpHealth({
        host: "127.0.0.1",
        port: 41032,
        timeoutMs: 5000,
        processName: "eveland-proj_a-dep_1",
        runtime: { verifyPortOwnership },
        waitForHealth,
      }),
    ).resolves.toBeUndefined();
    expect(waitForHealth).toHaveBeenCalledWith(
      expect.objectContaining({ host: "127.0.0.1", port: 41032 }),
    );
  });

  test("polls while the port is unbound and resolves once the process binds it", async () => {
    const answers: PortOwnership[] = [
      { status: "unbound" },
      { status: "unbound" },
      { status: "owned" },
    ];
    const verifyPortOwnership = vi.fn(
      async (): Promise<PortOwnership> => answers.shift() ?? { status: "owned" },
    );
    const waitForHealth = vi.fn(async () => undefined);

    await expect(
      waitForOwnedHttpHealth({
        host: "127.0.0.1",
        port: 41032,
        timeoutMs: 5000,
        pollIntervalMs: 5,
        processName: "eveland-proj_a-dep_1",
        runtime: { verifyPortOwnership },
        waitForHealth,
      }),
    ).resolves.toBeUndefined();
    expect(verifyPortOwnership).toHaveBeenCalledTimes(3);
  });

  test("rejects with a bind-timeout error when the process never binds", async () => {
    const verifyPortOwnership = vi.fn(async (): Promise<PortOwnership> => ({ status: "unbound" }));
    const waitForHealth = vi.fn();

    await expect(
      waitForOwnedHttpHealth({
        host: "127.0.0.1",
        port: 41032,
        timeoutMs: 200,
        pollIntervalMs: 10,
        processName: "eveland-proj_a-dep_1",
        runtime: { verifyPortOwnership },
        waitForHealth,
      }),
    ).rejects.toThrow(/did not bind 127\.0\.0\.1:41032 within 200ms/);
    expect(waitForHealth).not.toHaveBeenCalled();
  });

  test("falls back to the plain HTTP probe when the runtime cannot verify ownership", async () => {
    const waitForHealth = vi.fn(async () => undefined);

    await expect(
      waitForOwnedHttpHealth({
        host: "127.0.0.1",
        port: 41032,
        timeoutMs: 5000,
        processName: "eveland-proj_a-dep_1",
        runtime: {},
        waitForHealth,
      }),
    ).resolves.toBeUndefined();
    expect(waitForHealth).toHaveBeenCalledTimes(1);
  });
});
