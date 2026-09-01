import { apiRequest, type FetchLike } from "./api-client.ts";

/**
 * `eveland logs`: prints a project's log tail and optionally follows. Every
 * request is bounded server-side, and every response — including an empty
 * one — carries an opaque cursor, so the follower never falls back to an
 * unbounded read and never skips lines: when a page comes back full it pages
 * again immediately until it has caught up, then resumes the poll interval.
 */

const FOLLOW_INTERVAL_MS = 2_000;
const FOLLOW_PAGE_LIMIT = 500;

type LogRecord = { id: string; type: string; line: string; createdAt: string };
type LogPage = { logs: LogRecord[]; cursor: string };

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
  const typeQuery = input.type ? `type=${input.type}&` : "";
  const fetchPage = async (query: string) =>
    apiRequest<LogPage>({
      origin: input.origin,
      path: `/api/projects/${input.projectId}/logs?${typeQuery}${query}`,
      token: input.token,
      fetchImpl: io.fetchImpl,
    });

  const initial = await fetchPage(`limit=${Math.max(1, input.tail)}`);
  if (initial.logs.length === 0 && !input.follow) {
    io.print("No log lines.");
    return;
  }
  for (const log of initial.logs) io.print(formatLine(log));
  let cursor = initial.cursor;

  while (input.follow && !io.stopped?.()) {
    await sleep(FOLLOW_INTERVAL_MS);
    // Drain to the tip before sleeping again: a full page means more may be
    // waiting, and stopping early would delay (never lose) lines.
    for (;;) {
      const page = await fetchPage(
        `after=${encodeURIComponent(cursor)}&limit=${FOLLOW_PAGE_LIMIT}`,
      );
      for (const log of page.logs) io.print(formatLine(log));
      cursor = page.cursor;
      if (page.logs.length < FOLLOW_PAGE_LIMIT) break;
    }
  }
}

function formatLine(log: LogRecord): string {
  return `${log.createdAt}  [${log.type}] ${log.line}`;
}
