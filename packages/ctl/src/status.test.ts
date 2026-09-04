import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { applianceLayout } from "./home.ts";
import { PLATFORM_PROCESSES } from "./processes.ts";
import { writeSupervisorRecord, writeSupervisorState } from "./state-files.ts";
import { runStatus } from "./status.ts";
import type { LifecycleIo } from "./lifecycle.ts";
import type { TcpProbe } from "./status.ts";

async function makeHarness(options: {
  supervisorAlive?: boolean;
  childrenAlive?: boolean;
  healthOk?: boolean;
  tcpOk?: boolean;
}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-status-"));
  const repo = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-statusrepo-"));
  await writeFile(
    path.join(repo, ".env"),
    [
      "EVELAND_PUBLIC_ORIGIN=http://localhost:17300",
      "DATABASE_URL=postgres://eveland:eveland@127.0.0.1:17310/eveland",
    ].join("\n"),
    "utf8",
  );
  const layout = applianceLayout(home);
  const alivePids = new Set<number>();
  if (options.supervisorAlive) {
    alivePids.add(4242);
    await writeSupervisorRecord(layout, { pid: 4242, identity: "id-4242" });
    await writeSupervisorState(layout, {
      pid: 4242,
      startedAt: "2026-09-01T00:00:00.000Z",
      children: Object.fromEntries(
        PLATFORM_PROCESSES.map((spec) => [
          spec.key,
          { status: "running" as const, pid: 5000, restarts: 0, lastExit: null },
        ]),
      ),
    });
    if (options.childrenAlive !== false) alivePids.add(5000);
  }
  const out: string[] = [];
  const io: LifecycleIo & { tcpProbe: TcpProbe } = {
    env: { EVELAND_HOME: home },
    platform: "darwin",
    stdout: (line) => out.push(line),
    stderr: () => {},
    repoRootDir: repo,
    sleep: async () => {},
    isAlive: (pid) => alivePids.has(pid),
    processIdentity: async (pid) => (alivePids.has(pid) ? "id-" + pid : null),
    fetchImpl: async () =>
      (options.healthOk ?? true)
        ? new Response("{}", { status: 200 })
        : new Response("no", { status: 503 }),
    tcpProbe: async () => options.tcpOk ?? true,
    pgReady: async () => options.tcpOk ?? true,
  };
  return { io, out };
}

describe("runStatus", () => {
  test("all green exits 0 and shows the supervisor, processes, and infra", async () => {
    const harness = await makeHarness({ supervisorAlive: true });
    expect(await runStatus([], harness.io)).toBe(0);
    const output = harness.out.join("\n");
    expect(output).toContain("Supervisor: running (pid 4242");
    expect(output).toContain("✓ Agent Gateway");
    expect(output).toContain("✓ Postgres");
    // The address and the kind, never the DSN: this output ends up in issue
    // reports.
    expect(output).toContain("127.0.0.1:17310 (bundled)");
    expect(output).not.toContain("postgres://");
    expect(output).toContain("Origin: http://localhost:17300");
  });

  test("a stopped platform exits 1 and says the supervisor is down", async () => {
    const harness = await makeHarness({ supervisorAlive: false, tcpOk: false, healthOk: false });
    expect(await runStatus([], harness.io)).toBe(1);
    expect(harness.out.join("\n")).toContain("Supervisor: not running");
  });

  test("an alive child with a failing health probe is a failure, not a pass", async () => {
    const harness = await makeHarness({ supervisorAlive: true, healthOk: false });
    expect(await runStatus([], harness.io)).toBe(1);
    expect(harness.out.join("\n")).toContain("health FAILED");
  });

  test("unreachable infrastructure fails the status even when processes run", async () => {
    const harness = await makeHarness({ supervisorAlive: true, tcpOk: false });
    expect(await runStatus([], harness.io)).toBe(1);
    expect(harness.out.join("\n")).toContain("UNREACHABLE");
  });
});
