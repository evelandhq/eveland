import { apiRequest, type FetchLike } from "./api-client.ts";

/**
 * `eveland logs`: prints a project's log tail and optionally follows. Both
 * modes are bounded server-side — `limit` returns the last N rows, `after`
 * returns only rows past the last one seen — so neither the initial tail nor
 * a long-running follow ever re-downloads the project's full history.
 */

const FOLLOW_INTERVAL_MS = 2_000;
const FOLLOW_PAGE_LIMIT = 500;

type LogRecord = { id: string; type: string; line: string; createdAt: string };

export async function runLogs(input: {
  origin: string;
  token: string;
  projectId: string;
  type?: "build" | "deploy" | "runtime";
  tail: number;
  follow: boolean;
  io: {
    fetchImpl?: FetchLike;
    print: (line: string) => void;
    sleep?: (ms: number) => Promise<void>;
    /** Follow mode stops when this reports true (tests) or never (SIGINT). */
    stopped?: () => boolean;
  };
}): Promise<void> {
  const { io } = input;
  const sleep = io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const fetchLogs = async (query: string) =>
    (
      await apiRequest<{ logs: LogRecord[] }>({
        origin: input.origin,
        path: `/api/projects/${input.projectId}/logs?${query}`,
        token: input.token,
        fetchImpl: io.fetchImpl,
      })
    ).logs;
  const typeQuery = input.type ? `type=${input.type}&` : "";

  const initial = await fetchLogs(`${typeQuery}limit=${Math.max(1, input.tail)}`);
  if (initial.length === 0 && !input.follow) {
    io.print("No log lines.");
    return;
  }
  for (const log of initial) io.print(formatLine(log));
  let cursor = initial.at(-1)?.id ?? null;

  while (input.follow && !io.stopped?.()) {
    await sleep(FOLLOW_INTERVAL_MS);
    const fresh = cursor
      ? await fetchLogs(
          `${typeQuery}after=${encodeURIComponent(cursor)}&limit=${FOLLOW_PAGE_LIMIT}`,
        )
      : await fetchLogs(`${typeQuery}limit=${FOLLOW_PAGE_LIMIT}`);
    for (const log of fresh) io.print(formatLine(log));
    cursor = fresh.at(-1)?.id ?? cursor;
  }
}

function formatLine(log: LogRecord): string {
  return `${log.createdAt}  [${log.type}] ${log.line}`;
}
