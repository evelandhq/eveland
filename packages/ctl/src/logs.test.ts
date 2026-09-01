import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { applianceLayout } from "./home.ts";
import { runCtlLogs } from "./logs.ts";
import type { LifecycleIo } from "./lifecycle.ts";

async function makeHarness(files: Record<string, string>) {
  const home = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-logs-"));
  const layout = applianceLayout(home);
  await mkdir(layout.logsDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(layout.logsDir, name), content, "utf8");
  }
  const out: string[] = [];
  const err: string[] = [];
  const io: LifecycleIo & { stopped?: () => boolean } = {
    env: { EVELAND_HOME: home },
    platform: "darwin",
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    repoRootDir: home,
    sleep: async () => {},
  };
  return { io, out, err, layout };
}

describe("runCtlLogs", () => {
  test("with no arguments it tails every log file with headers", async () => {
    const harness = await makeHarness({
      "api.log": "api line 1\napi line 2\n",
      "gateway.log": "gw line\n",
    });
    expect(await runCtlLogs([], harness.io)).toBe(0);
    const output = harness.out.join("\n");
    expect(output).toContain("==> api <==");
    expect(output).toContain("api line 2");
    expect(output).toContain("==> gateway <==");
  });

  test("a process argument narrows to that file, and --tail limits lines", async () => {
    const harness = await makeHarness({
      "api.log": ["one", "two", "three", "four", ""].join("\n"),
      "gateway.log": "gw\n",
    });
    expect(await runCtlLogs(["api", "--tail", "2"], harness.io)).toBe(0);
    expect(harness.out).toEqual(["three", "four"]);
  });

  test("an unknown process name lists the known ones", async () => {
    const harness = await makeHarness({});
    expect(await runCtlLogs(["nginx"], harness.io)).toBe(1);
    expect(harness.err.join("\n")).toContain(
      "Known: gateway, api, web, worker, workflow-dispatcher, supervisor",
    );
  });

  test("no logs yet points at start", async () => {
    const harness = await makeHarness({});
    expect(await runCtlLogs([], harness.io)).toBe(1);
    expect(harness.err.join("\n")).toContain("eveland-ctl start");
  });

  test("--follow streams only appended bytes and stops via the stopped hook", async () => {
    const harness = await makeHarness({ "api.log": "old\n" });
    let polls = 0;
    harness.io.stopped = () => polls > 1;
    harness.io.sleep = async () => {
      polls += 1;
      if (polls === 1) {
        await appendFile(path.join(harness.layout.logsDir, "api.log"), "fresh\n", "utf8");
      }
    };
    expect(await runCtlLogs(["api", "--follow"], harness.io)).toBe(0);
    expect(harness.out).toEqual(["old", "fresh"]);
  });
});
