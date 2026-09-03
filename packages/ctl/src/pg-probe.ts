import { POSTGRES_DEFAULT_PORT } from "@evelandhq/core/ports";
import postgres from "postgres";

/**
 * Postgres checks that go through the configured DSN rather than a port.
 *
 * A bare TCP probe is a FALSE ready signal: Docker's port proxy, an SSH
 * tunnel, and a Lima port-forward all accept connections before (or without)
 * a Postgres behind them, and the migration then dies on "the database system
 * is starting up". Only a connection made with the address the platform
 * itself will use proves that address works.
 */

type Sql = ReturnType<typeof postgres>;

/** Seconds. Long enough for a real handshake, short enough to poll with. */
const CONNECT_TIMEOUT = 2;

/** Seconds. Bounds the connect *and* the query, which postgres.js does not. */
const PROBE_TIMEOUT = 5;

export type PgReady = (databaseUrl: string) => Promise<boolean>;

/** What one connection can tell `doctor` about a configured database. */
export type PgJournal =
  | { status: "unreachable"; detail: string }
  | { status: "unmigrated" }
  | { status: "migrated"; count: number };

export type PgJournalProbe = (databaseUrl: string) => Promise<PgJournal>;

/**
 * `connect_timeout` bounds the handshake and nothing after it. A server or
 * proxy that authenticates and then stops answering leaves the query pending
 * forever — which would let first boot sit past its own deadline and hang
 * `doctor` outright — so the whole exchange gets a deadline of its own.
 */
async function withClient<T>(databaseUrl: string, run: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = postgres(databaseUrl, {
    max: 1,
    connect_timeout: CONNECT_TIMEOUT,
    idle_timeout: CONNECT_TIMEOUT,
    onnotice: () => {},
  });
  let deadline: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(sql),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error(`no answer within ${PROBE_TIMEOUT}s`)),
          PROBE_TIMEOUT * 1_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(deadline);
    // A pending query would keep this open until it settles; the probe already
    // has its answer either way.
    await sql.end({ timeout: 0 });
  }
}

export function defaultPgReady(): PgReady {
  return async (databaseUrl) => {
    try {
      await withClient(databaseUrl, (sql) => sql`select 1`);
      return true;
    } catch {
      return false;
    }
  };
}

export function defaultPgJournalProbe(): PgJournalProbe {
  return async (databaseUrl) => {
    try {
      return await withClient(databaseUrl, async (sql) => {
        const rows = await sql<{ count: number }[]>`
          select count(*)::int as count from drizzle.__drizzle_migrations
        `;
        return { status: "migrated", count: rows[0]?.count ?? 0 } as const;
      });
    } catch (error) {
      // 42P01 undefined_table / 3F000 invalid_schema_name: the connection
      // worked and the journal is simply not there yet. Anything else means
      // the database could not be read at all.
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "42P01" || code === "3F000") return { status: "unmigrated" };
      return {
        status: "unreachable",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

/**
 * The host and port of a DSN, for comparison and for operator-facing text. The
 * DSN itself carries a password and must never reach stdout or a log.
 *
 * The host is the bare address: `URL` keeps an IPv6 literal in the brackets
 * the URL syntax needs, which no socket accepts and no comparison against a
 * plain `::1` matches.
 */
export function databaseAddress(databaseUrl: string): { host: string; port: number } | null {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^\[(.+)\]$/, "$1");
  if (!host) return null;
  const port = parsed.port ? Number(parsed.port) : POSTGRES_DEFAULT_PORT;
  return Number.isInteger(port) ? { host, port } : null;
}

/** `host:port` for a DSN, or null when it does not parse as one. */
export function describeDatabaseAddress(databaseUrl: string): string | null {
  const address = databaseAddress(databaseUrl);
  if (!address) return null;
  // An IPv6 literal needs its brackets back to read as one address.
  const host = address.host.includes(":") ? `[${address.host}]` : address.host;
  return `${host}:${address.port}`;
}
