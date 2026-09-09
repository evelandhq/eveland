import { WORKFLOW_DISPATCHER_OWNERSHIP_LOCK_KEY } from "@evelandhq/core/workflow-dispatch";
import postgres from "postgres";

/**
 * The session holding the workflow dispatcher's ownership lock, as Postgres
 * sees it. Only rows visible to the connected role carry details; the pid is
 * always there.
 */
export type DispatcherLockHolder = {
  pid: number;
  applicationName: string | null;
  clientAddr: string | null;
  backendStart: Date | null;
  state: string | null;
  stateChange: Date | null;
};

export type DispatcherLockStore = {
  holder(worldUrl: string): Promise<DispatcherLockHolder | null>;
  /** Whether a backend with that pid was signalled. */
  terminate(worldUrl: string, pid: number): Promise<boolean>;
};

const CONNECT_TIMEOUT = 10;

type Sql = ReturnType<typeof postgres>;

async function withWorld<T>(worldUrl: string, run: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = postgres(worldUrl, {
    max: 1,
    connect_timeout: CONNECT_TIMEOUT,
    idle_timeout: CONNECT_TIMEOUT,
    onnotice: () => {},
  });
  try {
    return await run(sql);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

/**
 * The same query `@evelandhq/workflow-world` runs to name the holder, written
 * here because the ctl depends on nothing but core. A bigint advisory key shows
 * up in `pg_locks` split into two 32-bit halves.
 */
export function defaultDispatcherLockStore(): DispatcherLockStore {
  const key = BigInt(WORKFLOW_DISPATCHER_OWNERSHIP_LOCK_KEY);
  const classid = Number(key >> 32n);
  const objid = Number(key & 0xffffffffn);
  return {
    holder: (worldUrl) =>
      withWorld(worldUrl, async (sql) => {
        const [row] = await sql<
          {
            pid: number;
            application_name: string | null;
            client_addr: string | null;
            backend_start: Date | null;
            state: string | null;
            state_change: Date | null;
          }[]
        >`
          select l.pid, a.application_name, host(a.client_addr) as client_addr,
                 a.backend_start, a.state, a.state_change
            from pg_locks l
            left join pg_stat_activity a on a.pid = l.pid
           where l.locktype = 'advisory'
             and l.database = (select oid from pg_database where datname = current_database())
             and l.classid = ${classid} and l.objid = ${objid} and l.objsubid = 1
             and l.granted
           order by l.pid
           limit 1
        `;
        return row
          ? {
              pid: row.pid,
              applicationName: row.application_name,
              clientAddr: row.client_addr,
              backendStart: row.backend_start,
              state: row.state,
              stateChange: row.state_change,
            }
          : null;
      }),
    terminate: (worldUrl, pid) =>
      withWorld(worldUrl, async (sql) => {
        const [row] = await sql<{ terminated: boolean }[]>`
          select pg_terminate_backend(${pid}) as terminated
        `;
        return row?.terminated ?? false;
      }),
  };
}
