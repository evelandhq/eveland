import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { writeInstallMetadata } from "./bootstrap.ts";
import { applianceLayout, readInstallMetadata } from "./home.ts";
import type { LifecycleIo } from "./io.ts";
import { PLATFORM_PROCESSES, processByKey, systemdUnitName } from "./processes.ts";
import { renderUnit, runInstallCommand } from "./systemd.ts";

describe("renderUnit", () => {
  test("a unit reads the single env file, runs from the app dir, and execs the process argv", () => {
    const unit = renderUnit(processByKey("gateway")!, {
      sourceDir: "/opt/eveland/source",
      envFilePath: "/opt/eveland/etc/eveland.env",
      nodeBinDir: "/opt/eveland/node/bin",
    });
    expect(unit).toContain("WorkingDirectory=/opt/eveland/source/apps/gateway");
    expect(unit).toContain("EnvironmentFile=/opt/eveland/etc/eveland.env");
    expect(unit).toContain("Environment=PATH=/opt/eveland/node/bin:");
    expect(unit).toContain(
      "ExecStart=/usr/bin/env pnpm exec tsx --import=@evelandhq/platform-observability/register src/server.ts",
    );
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=multi-user.target");
  });

  test("unit names converge with the documented worker/dispatcher services", () => {
    expect(systemdUnitName("worker")).toBe("eveland-worker.service");
    expect(systemdUnitName("workflow-dispatcher")).toBe("eveland-workflow-dispatcher.service");
  });
});

type InstallIo = LifecycleIo & { getuid?: () => number; systemdUnitDir?: string };

async function makeHarness(options: { uid?: number; bootstrapped?: boolean } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-systemd-"));
  const repo = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-systemdrepo-"));
  const unitDir = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-units-"));
  const layout = applianceLayout(home);
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(layout.etcDir, { recursive: true });
  await writeFile(
    layout.envFilePath,
    "APP_SECRET_KEY=k\nEVELAND_NODE=/opt/eveland/node/bin/node\n",
    "utf8",
  );
  if (options.bootstrapped !== false) {
    await writeInstallMetadata(layout, {
      version: 1,
      installedAt: "2026-09-01T00:00:00.000Z",
      method: "install.sh",
      osMode: "linux",
      bootstrapCompleted: true,
    });
  }
  const out: string[] = [];
  const err: string[] = [];
  const execCalls: string[][] = [];
  const io: InstallIo = {
    env: { EVELAND_HOME: home },
    platform: "linux",
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    repoRootDir: repo,
    sleep: async () => {},
    isAlive: () => false,
    execCommand: async (argv) => {
      execCalls.push(argv);
      return { code: 0, output: argv[1] === "is-active" ? "active\n" : "" };
    },
    getuid: () => options.uid ?? 0,
    systemdUnitDir: unitDir,
  };
  return { io, out, err, execCalls, layout, unitDir };
}

describe("runInstallCommand", () => {
  test("without --systemd it explains itself", async () => {
    const harness = await makeHarness({});
    expect(await runInstallCommand([], harness.io)).toBe(1);
    expect(harness.err.join("\n")).toContain("install --systemd");
  });

  test("refuses macOS and non-root", async () => {
    const mac = await makeHarness({});
    mac.io.platform = "darwin";
    expect(await runInstallCommand(["--systemd"], mac.io)).toBe(1);
    expect(mac.err.join("\n")).toContain("Linux-only");

    const nonRoot = await makeHarness({ uid: 1000 });
    expect(await runInstallCommand(["--systemd"], nonRoot.io)).toBe(1);
    expect(nonRoot.err.join("\n")).toContain("sudo");
  });

  test("refuses before a completed bootstrap", async () => {
    const harness = await makeHarness({ bootstrapped: false });
    expect(await runInstallCommand(["--systemd"], harness.io)).toBe(1);
    expect(harness.err.join("\n")).toContain("eveland-ctl start");
  });

  test("writes one unit per process, enables them, and flips supervision to systemd", async () => {
    const harness = await makeHarness({});
    expect(await runInstallCommand(["--systemd"], harness.io)).toBe(0);

    const units = (await readdir(harness.unitDir)).sort();
    expect(units).toEqual(PLATFORM_PROCESSES.map((spec) => systemdUnitName(spec.key)).sort());
    const workerUnit = await readFile(
      path.join(harness.unitDir, systemdUnitName("worker")),
      "utf8",
    );
    expect(workerUnit).toContain(`EnvironmentFile=${harness.layout.envFilePath}`);
    expect(workerUnit).toContain("Environment=PATH=/opt/eveland/node/bin:");

    expect(harness.execCalls).toContainEqual(["systemctl", "daemon-reload"]);
    for (const spec of PLATFORM_PROCESSES) {
      expect(harness.execCalls).toContainEqual([
        "systemctl",
        "enable",
        "--now",
        systemdUnitName(spec.key),
      ]);
    }
    expect((await readInstallMetadata(harness.layout))?.supervision).toBe("systemd");
  });
});
