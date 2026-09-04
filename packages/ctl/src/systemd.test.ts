import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { writeInstallMetadata } from "./bootstrap.ts";
import { applianceLayout, readInstallMetadata } from "./home.ts";
import type { LifecycleIo } from "./io.ts";
import { PLATFORM_PROCESSES, processByKey, systemdUnitName } from "./processes.ts";
import {
  DISPATCHER_ENV_KEYS,
  GATEWAY_ENV_KEYS,
  renderApplianceOverlay,
  renderDispatcherEnv,
  hostUnitsArmedPath,
  renderPlatformUnit,
  renderServiceEnv,
  RETIRED_COMPOSE_SERVICES,
  INFRA_COMPOSE_SERVICES,
  SYSTEMD_HOST_UNITS,
  WEB_ENV_KEYS,
} from "./systemd-mode.ts";
import { HOST_SERVICE_ACCOUNTS } from "./linux-host.ts";
import { runInstallCommand } from "./systemd.ts";

const UNIT_OPTIONS = {
  sourceDir: "/opt/eveland/source",
  etcDir: "/opt/eveland/etc",
  dataDir: "/opt/eveland/data",
  envFilePath: "/opt/eveland/etc/eveland.env",
  nodeBinDir: "/opt/eveland/node/bin",
  armedMarkerPath: "/opt/eveland/run/host-units-armed",
};

function unitFor(key: string): string {
  const spec = processByKey(key);
  if (!spec) throw new Error(`no process ${key}`);
  return renderPlatformUnit(spec, UNIT_OPTIONS);
}

describe("the systemd form's units", () => {
  test("every platform process has a unit, and nothing else does", () => {
    // The unit list IS the topology now. A process missing from it is a
    // process nothing starts.
    expect([...SYSTEMD_HOST_UNITS].sort()).toEqual(
      PLATFORM_PROCESSES.map((spec) => spec.key).sort(),
    );
  });

  test("Docker is left holding only the Collector and the bundled database", () => {
    expect([...INFRA_COMPOSE_SERVICES]).toEqual(["postgres", "otel-collector"]);
  });

  test("the API unit reads the whole configuration and can write only its data dir", () => {
    const unit = unitFor("api");
    expect(unit).toContain("User=eveland-platform");
    expect(unit).not.toContain("User=root");
    expect(unit).toContain("EnvironmentFile=/opt/eveland/etc/eveland-api.env");
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("ReadWritePaths=/var/lib/eveland-platform /opt/eveland/data");
    expect(unit).toContain(
      "ExecStart=/opt/eveland/source/node_modules/.bin/tsx --import=@evelandhq/platform-observability/register src/server.ts",
    );
    // Nothing orders itself after itself.
    expect(unit).not.toContain("eveland-api.service");
  });

  test("the worker unit is root on purpose and reads the full configuration", () => {
    const unit = unitFor("worker");
    expect(unit).toContain("User=root");
    expect(unit).toContain("WorkingDirectory=/opt/eveland/source/apps/worker");
    expect(unit).toContain("EnvironmentFile=/opt/eveland/etc/eveland-worker.env");
    expect(unit).toContain("ExecStart=/opt/eveland/source/node_modules/.bin/tsx src/worker.ts");
    expect(unit).toContain("Restart=on-failure");
    // Root drives systemd-run, systemctl, chown and mounts: sandboxing it
    // would break every deployment it starts.
    expect(unit).not.toContain("ProtectSystem=");
  });

  test("the dispatcher unit is DynamicUser with crash-loop caps and its OWN env file", () => {
    const unit = unitFor("workflow-dispatcher");
    expect(unit).toContain("DynamicUser=yes");
    expect(unit).not.toContain("User=root");
    expect(unit).toContain("EnvironmentFile=/opt/eveland/etc/eveland-workflow-dispatcher.env");
    expect(unit).toContain("StartLimitIntervalSec=300");
    expect(unit).toContain("StartLimitBurst=10");
    expect(unit).toContain("ExecStart=/opt/eveland/source/node_modules/.bin/tsx src/main.ts");
  });

  test("the front door runs on a throwaway uid of its own", () => {
    const unit = unitFor("gateway");
    // It owns no file that outlives a restart, so it needs no stable
    // identity — and a uid nobody else uses is what keeps a compromised
    // public proxy from reading the API's /proc/<pid>/environ.
    expect(unit).toContain("DynamicUser=yes");
    expect(unit).not.toContain("User=root");
    expect(unit).not.toContain("User=eveland-platform");
    expect(unit).not.toContain("ReadWritePaths=");
    expect(unit).toContain("ProtectProc=invisible");
    expect(unit).toContain("NoNewPrivileges=yes");
    expect(unit).toContain("EnvironmentFile=/opt/eveland/etc/eveland-gateway.env");
    expect(unit).toContain(
      "ExecStart=/opt/eveland/source/node_modules/.bin/tsx --import=@evelandhq/platform-observability/register src/server.ts",
    );
  });

  test("the Dashboard unit can write .next/cache and nothing else in the checkout", () => {
    const unit = unitFor("web");
    // Its own uid, not the API's: the Dashboard must not be one /proc read
    // away from APP_SECRET_KEY.
    expect(unit).toContain("User=eveland-web");
    expect(unit).not.toContain("eveland-platform");
    expect(unit).toContain("ProtectSystem=strict");
    // `next start` writes .next/cache on its first request; without this the
    // read-only checkout kills it.
    expect(unit).toContain(
      "ReadWritePaths=/var/lib/eveland-web /opt/eveland/source/apps/web/.next",
    );
    expect(unit).toContain("Environment=NEXT_TELEMETRY_DISABLED=1");
    // `next` is a web dependency, so its bin lives in that workspace.
    expect(unit).toContain(
      "ExecStart=/opt/eveland/source/apps/web/node_modules/.bin/next start --port 17302 --hostname 127.0.0.1",
    );
  });

  test("no unit goes through pnpm — corepack needs a writable HOME a unit does not have", () => {
    for (const key of SYSTEMD_HOST_UNITS) {
      expect(unitFor(key)).not.toMatch(/ExecStart=.*\bpnpm\b/);
    }
  });

  test("no two units share a uid", () => {
    // The whole point of the per-service env allowlists. Same-uid processes
    // read each other's /proc/<pid>/environ (PTRACE_MODE_READ_FSCREDS, which
    // Yama's ptrace_scope does not restrict), so one uid for two services
    // means the narrower service's allowlist buys nothing.
    const identities = SYSTEMD_HOST_UNITS.map((key) => {
      const unit = unitFor(key);
      if (unit.includes("DynamicUser=yes")) return `dynamic:${key}`;
      const user = /^User=(.+)$/m.exec(unit)?.[1];
      expect(user, `${key} declares no identity`).toBeDefined();
      return user!;
    });
    expect(new Set(identities).size).toBe(identities.length);
  });

  test("every unprivileged unit hides the rest of the process table", () => {
    for (const key of SYSTEMD_HOST_UNITS) {
      const unit = unitFor(key);
      if (unit.includes("User=root")) continue;
      expect(unit, key).toContain("ProtectProc=invisible");
    }
  });

  test("the crash-loop cap sits in [Unit], where systemd reads it", () => {
    // StartLimitIntervalSec/StartLimitBurst moved out of [Service] in systemd
    // v229; left there they are logged as unknown keys and ignored, and with
    // RestartSec=5 the default 10s/5 window never trips either — so a broken
    // config would restart forever instead of failing.
    for (const key of SYSTEMD_HOST_UNITS) {
      const unit = unitFor(key);
      const unitSection = unit.slice(unit.indexOf("[Unit]"), unit.indexOf("[Service]"));
      expect(unitSection, key).toContain("StartLimitIntervalSec=300");
      expect(unitSection, key).toContain("StartLimitBurst=10");
      expect(unit.slice(unit.indexOf("[Service]")), key).not.toContain("StartLimit");
    }
  });
});

describe("the dispatcher's narrowed environment", () => {
  test("carries only its documented variables — never the admin password or APP secret", () => {
    const rendered = renderDispatcherEnv({
      NODE_ENV: "production",
      EVELAND_WORKFLOW_WORLD_URL: "postgres://w",
      WORKFLOW_DISPATCHER_ACTIVATION_TOKEN: "activation-token",
      EVELAND_SCHEDULER_RUNTIME_SECRET: "runtime-secret",
      APP_SECRET_KEY: "must-not-appear",
      EVELAND_ADMIN_PASSWORD: "must-not-appear-either",
      BETTER_AUTH_SECRET: "nor-this",
      DATABASE_URL: "postgres://platform",
      EVELAND_GATEWAY_AFFINITY_SECRET: "nor-this-one",
    });
    expect(rendered).toContain("EVELAND_WORKFLOW_WORLD_URL=postgres://w");
    expect(rendered).toContain("WORKFLOW_DISPATCHER_ACTIVATION_TOKEN=activation-token");
    expect(rendered).not.toContain("must-not-appear");
    expect(rendered).not.toContain("nor-this");
    expect(rendered).not.toContain("DATABASE_URL");
    // The allowlist itself must never grow the platform-secret keys.
    for (const forbidden of [
      "APP_SECRET_KEY",
      "BETTER_AUTH_SECRET",
      "EVELAND_ADMIN_PASSWORD",
      "DATABASE_URL",
      "EVELAND_GATEWAY_AFFINITY_SECRET",
      "EVELAND_GATEWAY_SERVICE_TOKEN",
    ]) {
      expect(DISPATCHER_ENV_KEYS).not.toContain(forbidden);
    }
  });
});

describe("the public Gateway's and the Dashboard's narrowed environments", () => {
  const FULL = {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://platform",
    EVELAND_GATEWAY_SERVICE_TOKEN: "gw-token",
    EVELAND_GATEWAY_AFFINITY_SECRET: "affinity",
    EVELAND_AGENT_BASE_DOMAINS: "agent.localhost",
    API_URL: "http://api",
    APP_SECRET_KEY: "app-secret-must-not-appear",
    BETTER_AUTH_SECRET: "auth-secret-must-not-appear",
    EVELAND_ADMIN_PASSWORD: "admin-pw-must-not-appear",
    ANTHROPIC_API_KEY: "sk-ant-must-not-appear",
    EVELAND_SCHEDULER_DISPATCH_SECRET: "dispatch-must-not-appear",
  };

  test("the gateway file carries its compose-defined variables and nothing secret beyond them", () => {
    const rendered = renderServiceEnv("gateway", GATEWAY_ENV_KEYS, FULL);
    expect(rendered).toContain("EVELAND_GATEWAY_SERVICE_TOKEN=gw-token");
    expect(rendered).toContain("DATABASE_URL=postgres://platform");
    expect(rendered).not.toContain("must-not-appear");
    for (const forbidden of [
      "APP_SECRET_KEY",
      "BETTER_AUTH_SECRET",
      "EVELAND_ADMIN_PASSWORD",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "EVELAND_SCHEDULER_DISPATCH_SECRET",
      "EVELAND_SCHEDULER_RUNTIME_SECRET",
    ]) {
      expect(GATEWAY_ENV_KEYS).not.toContain(forbidden);
      expect(WEB_ENV_KEYS).not.toContain(forbidden);
    }
  });

  test("the dashboard file is tiny: release identity and the API address", () => {
    const rendered = renderServiceEnv("web", WEB_ENV_KEYS, FULL);
    expect(rendered).toContain("API_URL=http://api");
    expect(rendered).not.toContain("DATABASE_URL");
    expect(rendered).not.toContain("must-not-appear");
  });
});

describe("the appliance Compose overlay", () => {
  test("repoints data binds, masks native artifacts, and derives scheme/port from the origin", () => {
    const overlay = renderApplianceOverlay({ dataDir: "/opt/eveland/data" });
    expect(overlay).toContain("/opt/eveland/data/otel:/var/lib/eveland/otel");
    // Only the Collector is left to adjust. Every platform process is a host
    // unit, so nothing here may mention one -- and no bind may hand a
    // container the appliance source tree or its configuration.
    for (const gone of ["api", "worker", "gateway", "web"]) {
      expect(overlay).not.toContain(`  ${gone}:`);
    }
    expect(overlay).not.toContain("/workspace");
    expect(overlay).not.toContain("eveland.env");
  });
});

type InstallIo = LifecycleIo & { systemdUnitDir?: string };

async function makeHarness(options: { uid?: number; bootstrapped?: boolean } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-systemd-"));
  const repo = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-systemdrepo-"));
  const unitDir = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-units-"));
  const layout = applianceLayout(home);
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(layout.etcDir, { recursive: true });
  await writeFile(
    layout.envFilePath,
    [
      "NODE_ENV=production",
      "APP_SECRET_KEY=k",
      "EVELAND_PUBLIC_ORIGIN=http://localhost:17300",
      "EVELAND_DATA_DIR=" + layout.dataDir,
      "EVELAND_NODE=/opt/eveland/node/bin/node",
      "EVELAND_WORKFLOW_WORLD_URL=postgres://w",
      "WORKFLOW_DISPATCHER_ACTIVATION_TOKEN=tok",
    ].join("\n"),
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
  const written: Record<string, string> = {};
  const writtenAfterCall: Record<string, number> = {};
  const io: InstallIo = {
    env: { EVELAND_HOME: home },
    platform: "linux",
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    repoRootDir: repo,
    sleep: async () => {},
    isAlive: () => false,
    processIdentity: async () => null,
    fetchImpl: async () => new Response("{}", { status: 200 }),
    execCommand: async (argv) => {
      execCalls.push(argv);
      if (argv[0] === "systemctl" && argv[1] === "is-active")
        return { code: 0, output: "active\n" };
      // A host that has none of the service accounts yet, like the machine an
      // older installation updates from.
      if (argv[0] === "id") return { code: 1, output: "no such user\n" };
      return { code: 0, output: "" };
    },
    getuid: () => options.uid ?? 0,
    systemdUnitDir: unitDir,
    writeTextFile: async (filePath, content) => {
      written[filePath] = content;
      // How many commands had already run when this file appeared, so a test
      // can assert ordering between a write and the systemctl calls.
      writtenAfterCall[filePath] = execCalls.length;
      const { writeFile: write } = await import("node:fs/promises");
      await write(filePath, content, "utf8");
    },
  };
  return { io, out, err, execCalls, written, writtenAfterCall, layout, unitDir };
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

  test("a ctl supervisor that refuses to stop blocks the promotion outright", async () => {
    const harness = await makeHarness({});
    // A live supervisor that survives every signal.
    const { writeSupervisorRecord } = await import("./state-files.ts");
    await writeSupervisorRecord(harness.layout, { pid: 4242, identity: "id-4242" });
    harness.io.isAlive = () => true;
    harness.io.processIdentity = async () => "id-4242";
    harness.io.sendSignal = () => {};
    expect(await runInstallCommand(["--systemd"], harness.io)).toBe(1);
    expect(harness.err.join("\n")).toContain("could not be stopped");
    // Nothing was written or started: two owners must never coexist.
    expect(Object.keys(harness.written)).toEqual([]);
    expect(harness.execCalls.some((argv) => argv[0] === "systemctl")).toBe(false);
  });

  test("promotes: one unit per platform process, narrowed env, overlay, infra up, units started", async () => {
    const harness = await makeHarness({});
    expect(await runInstallCommand(["--systemd"], harness.io)).toBe(0);

    // Exactly one unit per platform process.
    const unitPaths = Object.keys(harness.written).filter((p) => p.startsWith(harness.unitDir));
    expect(unitPaths.sort()).toEqual(
      SYSTEMD_HOST_UNITS.map((key) => path.join(harness.unitDir, systemdUnitName(key))).sort(),
    );
    const workerUnit = harness.written[path.join(harness.unitDir, systemdUnitName("worker"))]!;
    expect(workerUnit).toContain("User=root");
    const dispatcherUnit =
      harness.written[path.join(harness.unitDir, systemdUnitName("workflow-dispatcher"))]!;
    expect(dispatcherUnit).toContain("DynamicUser=yes");

    // The dispatcher env file landed narrowed (no APP_SECRET_KEY).
    const dispatcherEnv = await readFile(
      path.join(harness.layout.etcDir, "eveland-workflow-dispatcher.env"),
      "utf8",
    );
    expect(dispatcherEnv).toContain("EVELAND_WORKFLOW_WORLD_URL=postgres://w");
    expect(dispatcherEnv).not.toContain("APP_SECRET_KEY");
    // The public Gateway's and the Dashboard's files are narrowed too.
    const gatewayEnv = await readFile(
      path.join(harness.layout.etcDir, "eveland-gateway.env"),
      "utf8",
    );
    expect(gatewayEnv).not.toContain("APP_SECRET_KEY");
    const webEnv = await readFile(path.join(harness.layout.etcDir, "eveland-web.env"), "utf8");
    expect(webEnv).not.toContain("APP_SECRET_KEY");
    expect(webEnv).not.toContain("WORKFLOW_DISPATCHER_ACTIVATION_TOKEN");
    // The API's file is the whole configuration plus what this form derives.
    const apiEnv = await readFile(path.join(harness.layout.etcDir, "eveland-api.env"), "utf8");
    expect(apiEnv).toContain("APP_SECRET_KEY=k");
    expect(apiEnv).toContain("EVELAND_GATEWAY_PUBLIC_SCHEME=http");
    expect(apiEnv).toContain("EVELAND_API_BIND_HOST=127.0.0.1");
    expect(apiEnv).toContain("EVELAND_GATEWAY_INTERNAL_URL=");

    // Compose brings up the infrastructure, and only that, with the
    // three-file stack.
    const composeUp = harness.execCalls.find((argv) => argv.includes("up"));
    expect(composeUp).toBeDefined();
    expect(composeUp!.join(" ")).toContain("docker-compose.prod.yml");
    expect(composeUp!.join(" ")).toContain("compose.appliance.yml");
    for (const service of INFRA_COMPOSE_SERVICES) {
      expect(composeUp).toContain(service);
    }
    for (const key of SYSTEMD_HOST_UNITS) expect(composeUp).not.toContain(key);

    // Containers this form no longer runs are actively removed: a leftover
    // one still holds the port its host unit is about to bind.
    const removal = harness.execCalls.find((argv) => argv.includes("rm"));
    expect(removal).toBeDefined();
    for (const { service, profile } of RETIRED_COMPOSE_SERVICES) {
      expect(removal!.join(" ")).toContain(`--profile ${profile}`);
      expect(removal).toContain(service);
    }
    expect(removal!.join(" ")).toContain("--stop --force");

    // Both units enabled and started; supervision recorded.
    for (const key of SYSTEMD_HOST_UNITS) {
      expect(harness.execCalls).toContainEqual(["systemctl", "enable", systemdUnitName(key)]);
      expect(harness.execCalls).toContainEqual(["systemctl", "start", systemdUnitName(key)]);
    }
    expect((await readInstallMetadata(harness.layout))?.supervision).toBe("systemd");
  });

  test("the accounts the units name are created before the units that name them", async () => {
    // An installation made before a service had its own identity first meets
    // those units on an update, which never re-runs the first-boot host
    // provisioning. A unit whose User= does not exist fails to start.
    const harness = await makeHarness({});
    expect(await runInstallCommand(["--systemd"], harness.io)).toBe(0);
    for (const account of HOST_SERVICE_ACCOUNTS) {
      expect(
        harness.execCalls.some((argv) => argv[0] === "useradd" && argv.includes(account.user)),
      ).toBe(true);
    }
    const firstUseradd = harness.execCalls.findIndex((argv) => argv[0] === "useradd");
    const webUnit = path.join(harness.unitDir, systemdUnitName("web"));
    expect(harness.writtenAfterCall[webUnit]).toBeGreaterThan(firstUseradd);
  });

  test("the units are armed for unattended boot only once everything else has run", async () => {
    const harness = await makeHarness({});
    expect(await runInstallCommand(["--systemd"], harness.io)).toBe(0);

    // Every unit gates on the marker...
    const markerPath = hostUnitsArmedPath(harness.layout);
    for (const key of SYSTEMD_HOST_UNITS) {
      const unit = harness.written[path.join(harness.unitDir, systemdUnitName(key))]!;
      expect(unit, key).toContain(`ConditionPathExists=${markerPath}`);
    }
    // ...and it is written, but only after the enable/build/migrate steps: a
    // reboot before this point must leave the units skipped, not running new
    // code against an old schema.
    await expect(readFile(markerPath, "utf8")).resolves.toContain("ConditionPathExists");
    const enabledAt = harness.execCalls.findIndex(
      (argv) => argv[0] === "systemctl" && argv[1] === "enable",
    );
    expect(harness.writtenAfterCall[markerPath]).toBeGreaterThan(enabledAt);
  });
});
