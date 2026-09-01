import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { resolveLifecycle, type LifecycleIo } from "./lifecycle.ts";
import { PLATFORM_PROCESSES } from "./processes.ts";

/**
 * `eveland-ctl logs`: the supervised processes' log files under the appliance
 * logs/ directory. This is the platform's own stdout/stderr — a deployed
 * project's logs belong to `eveland logs`, which reads them over the API.
 */

const DEFAULT_TAIL_LINES = 100;
const FOLLOW_POLL_MS = 1_000;

export async function runCtlLogs(
  args: string[],
  io: LifecycleIo & { stopped?: () => boolean },
): Promise<number> {
  const parsed = parseArgs({
    args,
    options: {
      follow: { type: "boolean", short: "f" },
      tail: { type: "string" },
    },
    allowPositionals: true,
  });
  const resolved = resolveLifecycle(io);
  const tailLines = Number(parsed.values.tail ?? DEFAULT_TAIL_LINES) || DEFAULT_TAIL_LINES;
  const name = parsed.positionals[0];
  const known = [...PLATFORM_PROCESSES.map((spec) => spec.key), "supervisor"];
  if (name && !known.includes(name)) {
    io.stderr(`Unknown process '${name}'. Known: ${known.join(", ")}.`);
    return 1;
  }

  let files: string[];
  try {
    const entries = await readdir(resolved.layout.logsDir);
    files = entries
      .filter((entry) => entry.endsWith(".log"))
      .filter((entry) => !name || entry === `${name}.log`)
      .sort()
      .map((entry) => path.join(resolved.layout.logsDir, entry));
  } catch {
    files = [];
  }
  if (files.length === 0) {
    io.stderr(
      name
        ? `No log file for '${name}' yet in ${resolved.layout.logsDir}.`
        : `No logs yet in ${resolved.layout.logsDir}. Has \`eveland-ctl start\` run?`,
    );
    return 1;
  }

  const offsets = new Map<string, number>();
  for (const file of files) {
    const raw = await readFile(file, "utf8").catch(() => "");
    if (files.length > 1) io.stdout(`==> ${path.basename(file, ".log")} <==`);
    const lines = raw.split("\n");
    if (lines.at(-1) === "") lines.pop();
    for (const line of lines.slice(-tailLines)) io.stdout(line);
    if (files.length > 1) io.stdout("");
    offsets.set(file, Buffer.byteLength(raw));
  }

  if (!parsed.values.follow) return 0;
  const sleep = io.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  while (!io.stopped?.()) {
    for (const file of files) {
      const size = await stat(file)
        .then((s) => s.size)
        .catch(() => 0);
      const offset = offsets.get(file) ?? 0;
      if (size <= offset) {
        if (size < offset) offsets.set(file, 0);
        continue;
      }
      const buffer = await readFile(file).catch(() => Buffer.alloc(0));
      const fresh = buffer.subarray(offset).toString("utf8");
      offsets.set(file, buffer.byteLength);
      const prefix = files.length > 1 ? `[${path.basename(file, ".log")}] ` : "";
      for (const line of fresh.split("\n")) {
        if (line !== "") io.stdout(`${prefix}${line}`);
      }
    }
    await sleep(FOLLOW_POLL_MS);
  }
  return 0;
}
