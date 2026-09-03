import net from "node:net";
import { describe, expect, test } from "vitest";
import {
  databaseAddress,
  defaultPgJournalProbe,
  defaultPgReady,
  describeDatabaseAddress,
} from "./pg-probe.ts";

/** A socket that accepts a connection and then says nothing at all. */
async function silentListener(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    port: address.port,
    // `close` alone waits for every accepted socket to end, and a probe that
    // gave up may leave its own open — so tear them down explicitly.
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A port nothing listens on, taken by binding and immediately releasing it. */
async function closedPort(): Promise<number> {
  const listener = await silentListener();
  await listener.close();
  return listener.port;
}

describe("databaseAddress", () => {
  test("reads host and port, defaulting the port Postgres itself defaults", () => {
    expect(databaseAddress("postgres://u:p@db.internal:6543/eveland")).toEqual({
      host: "db.internal",
      port: 6543,
    });
    expect(databaseAddress("postgres://u:p@db.internal/eveland")).toEqual({
      host: "db.internal",
      port: 5432,
    });
  });

  test("an IPv6 literal loses its brackets, and gets them back only for display", () => {
    // `doctor` compares this host against a plain "::1", and no socket accepts
    // the bracketed form — but one address has to read as one address.
    expect(databaseAddress("postgres://u@[::1]:5432/eveland")).toEqual({ host: "::1", port: 5432 });
    expect(describeDatabaseAddress("postgres://u@[::1]:5432/eveland")).toBe("[::1]:5432");
  });

  test("what is not a URL, or carries no host, is null rather than a guess", () => {
    expect(databaseAddress("not-a-dsn")).toBeNull();
    expect(databaseAddress("host=db user=eveland")).toBeNull();
    expect(describeDatabaseAddress("not-a-dsn")).toBeNull();
  });

  test("the description is address only — a DSN carries a password", () => {
    const described = describeDatabaseAddress("postgres://u:s3cr3t@db.internal:5432/eveland");
    expect(described).toBe("db.internal:5432");
    expect(described).not.toContain("s3cr3t");
  });
});

describe("defaultPgReady", () => {
  test("a port that accepts a connection and never answers is not ready", async () => {
    // The reason this module exists: Docker's port proxy, an SSH tunnel and a
    // Lima port-forward all accept before (or without) a Postgres behind them.
    // Such an address must resolve to false, and must not hang the caller —
    // first boot polls this against a 120-second deadline.
    const listener = await silentListener();
    try {
      const started = Date.now();
      await expect(
        defaultPgReady()(`postgres://eveland:eveland@127.0.0.1:${listener.port}/eveland`),
      ).resolves.toBe(false);
      expect(Date.now() - started).toBeLessThan(20_000);
    } finally {
      await listener.close();
    }
  }, 30_000);

  test("a refused connection is not ready", async () => {
    const port = await closedPort();
    await expect(
      defaultPgReady()(`postgres://eveland:eveland@127.0.0.1:${port}/eveland`),
    ).resolves.toBe(false);
  }, 30_000);
});

describe("defaultPgJournalProbe", () => {
  test("a database that cannot be reached at all reports unreachable, with the reason", async () => {
    const port = await closedPort();
    const journal = await defaultPgJournalProbe()(
      `postgres://eveland:eveland@127.0.0.1:${port}/eveland`,
    );
    expect(journal.status).toBe("unreachable");
    if (journal.status === "unreachable") expect(journal.detail).toBeTruthy();
  }, 30_000);
});
