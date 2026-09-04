import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { applianceLayout } from "./home.ts";
import { writeInstallMetadata } from "./bootstrap.ts";
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
  /** The checkout: version on disk, git HEAD, and the tag it sits on (if any). */
  version?: string;
  revision?: string;
  tag?: string | null;
  /** What etc/eveland.env pins — i.e. what the running processes were started with. */
  pinnedRevision?: string;
  /** A published run/update-check.json. */
  check?: Record<string, unknown>;
  installed?: boolean;
  updateCheckEnv?: string;
}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-status-"));
  const repo = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-statusrepo-"));
  await writeFile(
    path.join(repo, ".env"),
    [
      "EVELAND_PUBLIC_ORIGIN=http://localhost:17300",
      "DATABASE_URL=postgres://eveland:eveland@127.0.0.1:17310/eveland",
      ...(options.pinnedRevision ? [`EVELAND_REVISION=${options.pinnedRevision}`] : []),
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(repo, "package.json"),
    JSON.stringify({ version: options.version ?? "0.51.2" }),
    "utf8",
  );
  const layout = applianceLayout(home);
  if (options.installed) {
    await mkdir(layout.etcDir, { recursive: true });
    await writeInstallMetadata(layout, {
      version: 1,
      installedAt: "2026-09-01T00:00:00.000Z",
      method: "install.sh",
      osMode: "darwin",
      bootstrapCompleted: true,
    });
  }
  if (options.check) {
    await mkdir(layout.runDir, { recursive: true });
    await writeFile(
      path.join(layout.runDir, "update-check.json"),
      JSON.stringify(options.check),
      "utf8",
    );
  }
  const daemonArgv: string[][] = [];
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
    execCommand: async (argv) => {
      if (argv[1] === "rev-parse")
        return { code: 0, output: `${options.revision ?? "aaaaaaaaaaaa"}\n` };
      if (argv[1] === "describe") {
        const tag = options.tag === undefined ? "v0.51.2" : options.tag;
        return tag ? { code: 0, output: `${tag}\n` } : { code: 128, output: "no tag" };
      }
      return { code: 0, output: "" };
    },
    spawnDaemon: async ({ argv }) => {
      daemonArgv.push(argv);
      return 1;
    },
  };
  if (options.updateCheckEnv) io.env.EVELAND_UPDATE_CHECK = options.updateCheckEnv;
  return { io, out, daemonArgv, layout };
}

const STABLE_CHECK = {
  checkedAt: new Date().toISOString(),
  version: "0.51.2",
  revision: "aaaaaaaaaaaa",
  channel: "stable",
  tag: "v0.51.2",
  latestTag: "v0.51.2",
  breaking: [],
};

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

describe("the release block", () => {
  test("leads the output with the version, channel and revision on disk", async () => {
    const harness = await makeHarness({ supervisorAlive: true, revision: "6c1e3b8f2a91" });
    expect(await runStatus([], harness.io)).toBe(0);
    // First line, not buried: this is the output that gets pasted into a bug
    // report, and the version is the first thing every one of them needs.
    expect(harness.out[0]).toBe("Release: v0.51.2 (stable) 6c1e3b8f2a91");
  });

  test("announces a newer release with the breaking changes it crosses", async () => {
    const harness = await makeHarness({
      supervisorAlive: true,
      check: { ...STABLE_CHECK, latestTag: "v0.52.0", breaking: ["0.52.0"] },
    });
    expect(await runStatus([], harness.io)).toBe(0);
    const output = harness.out.join("\n");
    expect(output).toContain("v0.52.0 is available");
    expect(output).toContain("crosses BREAKING CHANGES in v0.52.0");
    expect(output).toContain("eveland-ctl update");
  });

  test("a release behind is still healthy: the exit code never moves", async () => {
    // Operators script `status`. Turning "there is a newer version" into a
    // non-zero exit would break every one of those scripts on release day.
    const harness = await makeHarness({
      supervisorAlive: true,
      check: { ...STABLE_CHECK, latestTag: "v9.9.9" },
    });
    expect(await runStatus([], harness.io)).toBe(0);
  });

  test("never claims the installation is up to date", async () => {
    // The check is a cached file that can be a month old on a machine nobody
    // logs into. Silence is always correct; "up to date" is wrong exactly
    // when it matters.
    const harness = await makeHarness({ supervisorAlive: true, check: STABLE_CHECK });
    await runStatus([], harness.io);
    const output = harness.out.join("\n").toLowerCase();
    expect(output).not.toContain("up to date");
    expect(output).not.toContain("latest");
  });

  test("with no cached check it reports the release and claims nothing else", async () => {
    const harness = await makeHarness({ supervisorAlive: true });
    expect(await runStatus([], harness.io)).toBe(0);
    expect(harness.out.join("\n")).not.toContain("is available");
  });

  test("an edge checkout is never told it is behind a release", async () => {
    // edge sits on a commit no tag names; "you are not on the latest release"
    // is meaningless there, and the ctl never writes a latestTag for it.
    const harness = await makeHarness({
      supervisorAlive: true,
      tag: null,
      check: { ...STABLE_CHECK, channel: "edge", tag: null, latestTag: null },
    });
    expect(await runStatus([], harness.io)).toBe(0);
    expect(harness.out[0]).toContain("(edge)");
    expect(harness.out.join("\n")).not.toContain("is available");
  });

  test("calls out a checkout that moved under the running processes", async () => {
    const harness = await makeHarness({
      supervisorAlive: true,
      revision: "6c1e3b8f2a91",
      pinnedRevision: "b53ed56a1c22",
    });
    expect(await runStatus([], harness.io)).toBe(0);
    const output = harness.out.join("\n");
    expect(output).toContain("The platform was started from b53ed56a1c22");
    expect(output).toContain("the checkout is now 6c1e3b8f2a91");
  });

  test("a stale check is refreshed in the background, never inline", async () => {
    const harness = await makeHarness({
      supervisorAlive: true,
      installed: true,
      check: { ...STABLE_CHECK, checkedAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(await runStatus([], harness.io)).toBe(0);
    // status is run when something is already broken: it reads a file and
    // hands the network call to a detached process.
    expect(harness.daemonArgv.some((argv) => argv.includes("_check-update"))).toBe(true);
    expect(harness.io.execCommand).toBeDefined();
  });

  test("a fresh check is not re-fetched", async () => {
    const harness = await makeHarness({
      supervisorAlive: true,
      installed: true,
      check: STABLE_CHECK,
    });
    await runStatus([], harness.io);
    expect(harness.daemonArgv).toEqual([]);
  });

  test("a development checkout publishes nothing", async () => {
    // No appliance root to write into, and nothing that would read one.
    const harness = await makeHarness({ supervisorAlive: true });
    await runStatus([], harness.io);
    expect(harness.daemonArgv).toEqual([]);
  });

  test("with checks off the remote is left alone, but a moved checkout still republishes", async () => {
    const off = await makeHarness({
      supervisorAlive: true,
      installed: true,
      updateCheckEnv: "off",
      check: { ...STABLE_CHECK, checkedAt: "2026-01-01T00:00:00.000Z" },
    });
    await runStatus([], off.io);
    expect(off.daemonArgv).toEqual([]);

    const moved = await makeHarness({
      supervisorAlive: true,
      installed: true,
      updateCheckEnv: "off",
      revision: "ffffffffffff",
      check: STABLE_CHECK,
    });
    await runStatus([], moved.io);
    expect(moved.daemonArgv.some((argv) => argv.includes("_check-update"))).toBe(true);
  });
});
