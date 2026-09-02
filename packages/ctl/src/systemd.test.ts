import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { writeInstallMetadata } from "./bootstrap.ts";
import { applianceLayout, readInstallMetadata } from "./home.ts";
import type { LifecycleIo } from "./io.ts";
import { systemdUnitName } from "./processes.ts";
import {
  DISPATCHER_ENV_KEYS,
  GATEWAY_ENV_KEYS,
  renderApplianceOverlay,
  renderDispatcherEnv,
  renderDispatcherUnit,
  renderServiceEnv,
  renderWorkerUnit,
  SYSTEMD_HOST_UNITS,
  WEB_ENV_KEYS,
} from "./systemd-mode.ts";
import { runInstallCommand } from "./systemd.ts";

describe("the systemd form's units", () => {
  test("exactly two host units exist — core services stay behind the Compose boundary", () => {
    expect([...SYSTEMD_HOST_UNITS]).toEqual(["worker", "workflow-dispatcher"]);
  });

  test("the worker unit is root on purpose and reads the full configuration", () => {
    const unit = renderWorkerUnit({
      sourceDir: "/opt/eveland/source",
      envFilePath: "/opt/eveland/etc/eveland.env",
      nodeBinDir: "/opt/eveland/node/bin",
    });
    expect(unit).toContain("User=root");
    expect(unit).toContain("WorkingDirectory=/opt/eveland/source/apps/worker");
    expect(unit).toContain("EnvironmentFile=/opt/eveland/etc/eveland.env");
    expect(unit).toContain("ExecStart=/opt/eveland/source/node_modules/.bin/tsx src/worker.ts");
    expect(unit).toContain("Restart=on-failure");
  });

  test("the dispatcher unit is DynamicUser with crash-loop caps and its OWN env file", () => {
    const unit = renderDispatcherUnit({
      sourceDir: "/opt/eveland/source",
      etcDir: "/opt/eveland/etc",
      nodeBinDir: "/opt/eveland/node/bin",
    });
    expect(unit).toContain("DynamicUser=yes");
    expect(unit).not.toContain("User=root");
    expect(unit).toContain("EnvironmentFile=/opt/eveland/etc/eveland-workflow-dispatcher.env");
    expect(unit).toContain("StartLimitIntervalSec=300");
    expect(unit).toContain("StartLimitBurst=10");
    expect(unit).toContain("ExecStart=/opt/eveland/source/node_modules/.bin/tsx src/main.ts");
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
    const overlay = renderApplianceOverlay({
      dataDir: "/opt/eveland/data",
      publicOrigin: "http://localhost:17300",
      envFilePath: "/opt/eveland/etc/eveland.env",
      gatewayEnvFilePath: "/opt/eveland/etc/eveland-gateway.env",
      webEnvFilePath: "/opt/eveland/etc/eveland-web.env",
    });
    expect(overlay).toContain("- /opt/eveland/data:/opt/eveland/data");
    expect(overlay).toContain("EVELAND_DATA_DIR: /opt/eveland/data");
    expect(overlay).toContain("eveland-appliance-api-node-modules:/workspace/node_modules");
    // The prod commands read /workspace/.env at runtime. Only the API gets
    // the full configuration; the public Gateway and the Dashboard get their
    // allowlisted files — the full file must appear exactly once.
    expect(overlay).toContain("- /opt/eveland/etc/eveland.env:/workspace/.env:ro");
    expect(overlay.split("/opt/eveland/etc/eveland.env:/workspace/.env").length - 1).toBe(1);
    expect(overlay).toContain("- /opt/eveland/etc/eveland-gateway.env:/workspace/.env:ro");
    expect(overlay).toContain("- /opt/eveland/etc/eveland-web.env:/workspace/.env:ro");
    expect(overlay).toContain("eveland-appliance-gateway-node-modules:/workspace/node_modules");
    expect(overlay).toContain("eveland-appliance-web-node-modules:/workspace/node_modules");
    expect(overlay).toContain("eveland-appliance-web-next:/workspace/apps/web/.next");
    expect(overlay).toContain("eveland-gateway-data-mask:/workspace/.eveland-data");
    expect(overlay).toContain("EVELAND_GATEWAY_PUBLIC_SCHEME: http");
    // Host networking has no service DNS; the front door's web upstream
    // must be loopback.
    expect(overlay).toContain("EVELAND_WEB_INTERNAL_URL: http://127.0.0.1:17302");
    expect(overlay).toContain('EVELAND_GATEWAY_PUBLIC_PORT: "17300"');
    expect(overlay).toContain("/opt/eveland/data/otel:/var/lib/eveland/otel");
    // Worker and dispatcher never appear: they are host units, not services.
    expect(overlay).not.toContain("worker");
  });

  test("an https origin on the default port drops the public port", () => {
    const overlay = renderApplianceOverlay({
      dataDir: "/opt/eveland/data",
      publicOrigin: "https://eveland.example.com",
      envFilePath: "/opt/eveland/etc/eveland.env",
      gatewayEnvFilePath: "/opt/eveland/etc/eveland-gateway.env",
      webEnvFilePath: "/opt/eveland/etc/eveland-web.env",
    });
    expect(overlay).toContain("EVELAND_GATEWAY_PUBLIC_SCHEME: https");
    expect(overlay).toContain('EVELAND_GATEWAY_PUBLIC_PORT: "0"');
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
      return { code: 0, output: "" };
    },
    getuid: () => options.uid ?? 0,
    systemdUnitDir: unitDir,
    writeTextFile: async (filePath, content) => {
      written[filePath] = content;
      const { writeFile: write } = await import("node:fs/promises");
      await write(filePath, content, "utf8");
    },
  };
  return { io, out, err, execCalls, written, layout, unitDir };
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

  test("promotes: TWO units, dispatcher env, overlay, compose core up, units started", async () => {
    const harness = await makeHarness({});
    expect(await runInstallCommand(["--systemd"], harness.io)).toBe(0);

    // Exactly the two documented units; nothing for gateway/api/web.
    const unitPaths = Object.keys(harness.written).filter((p) => p.startsWith(harness.unitDir));
    expect(unitPaths.sort()).toEqual(
      [
        path.join(harness.unitDir, systemdUnitName("worker")),
        path.join(harness.unitDir, systemdUnitName("workflow-dispatcher")),
      ].sort(),
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

    // Compose brings up infra + core services with the three-file stack.
    const composeUp = harness.execCalls.find((argv) => argv.includes("up"));
    expect(composeUp).toBeDefined();
    expect(composeUp!.join(" ")).toContain("docker-compose.prod.yml");
    expect(composeUp!.join(" ")).toContain("compose.appliance.yml");
    for (const service of ["postgres", "otel-collector", "api", "gateway", "web"]) {
      expect(composeUp).toContain(service);
    }
    expect(composeUp!.join(" ")).not.toMatch(/ worker/);

    // Both units enabled and started; supervision recorded.
    for (const key of SYSTEMD_HOST_UNITS) {
      expect(harness.execCalls).toContainEqual(["systemctl", "enable", systemdUnitName(key)]);
      expect(harness.execCalls).toContainEqual(["systemctl", "start", systemdUnitName(key)]);
    }
    expect((await readInstallMetadata(harness.layout))?.supervision).toBe("systemd");
  });
});
