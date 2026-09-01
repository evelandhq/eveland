import { apiRequest, type FetchLike } from "./api-client.ts";

/**
 * `eveland logs`: prints a project's log tail and optionally follows. The
 * logs endpoint returns the full ascending history with no cursor, so the
 * CLI tails client-side and follows by polling with id-dedupe — the same
 * pattern the Dashboard uses.
 */

const FOLLOW_INTERVAL_MS = 2_000;

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
  const typeQuery = input.type ? `?type=${input.type}` : "";
  const fetchLogs = async () =>
    (
      await apiRequest<{ logs: LogRecord[] }>({
        origin: input.origin,
        path: `/api/projects/${input.projectId}/logs${typeQuery}`,
        token: input.token,
        fetchImpl: io.fetchImpl,
      })
    ).logs;

  const initial = await fetchLogs();
  const seen = new Set(initial.map((log) => log.id));
  const shown = initial.slice(-Math.max(0, input.tail));
  if (shown.length === 0 && !input.follow) {
    io.print("No log lines.");
    return;
  }
  for (const log of shown) io.print(formatLine(log));

  while (input.follow && !io.stopped?.()) {
    await sleep(FOLLOW_INTERVAL_MS);
    for (const log of await fetchLogs()) {
      if (seen.has(log.id)) continue;
      seen.add(log.id);
      io.print(formatLine(log));
    }
  }
}

function formatLine(log: LogRecord): string {
  return `${log.createdAt}  [${log.type}] ${log.line}`;
}
