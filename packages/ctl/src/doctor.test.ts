import { describe, expect, test } from "vitest";
import { API_PORT, POSTGRES_HOST_PORT, WEB_PORT } from "@evelandhq/core/ports";
import { collectDoctorChecks, type DoctorDeps } from "./doctor.ts";

function makeDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    env: {},
    platform: "darwin",
    nodeVersion: "v24.5.0",
    repoRootDir: "/repo",
    envFile: {
      path: "/repo/.env",
      values: {
        NODE_ENV: "development",
        DATABASE_URL: "postgres://eveland:eveland@localhost/eveland",
        APP_SECRET_KEY: "k".repeat(32),
        BETTER_AUTH_SECRET: "s".repeat(32),
        EVELAND_ADMIN_PASSWORD: "long-enough-password",
      },
    },
    supervisorRunning: false,
    database: "bundled",
    pgJournalProbe: async () => ({ status: "migrated", count: 42 }),
    execCommand: async (argv) => {
      if (argv[0] === "pnpm") return { code: 0, output: "11.7.0\n" };
      if (argv[0] === "docker" && argv[1] === "info") return { code: 0, output: "27.0\n" };
      if (argv[0] === "unzip") return { code: 0, output: "UnZip 6.00 ... Info-ZIP.\n" };
      if (argv[1] === "compose") return { code: 0, output: "42\n" };
      return { code: 0, output: "" };
    },
    tcpProbe: async () => false,
    fetchImpl: async () => new Response("{}", { status: 200 }),
    fileExists: async () => false,
    freeDiskBytes: async () => 100 * 1024 ** 3,
    nonLoopbackAddresses: () => [],
    dockerBridgeHost: async () => null,
    readTextFile: async () => null,
    ...overrides,
  };
}

function byName(checks: Awaited<ReturnType<typeof collectDoctorChecks>>, name: string) {
  return checks.find((check) => check.name === name);
}

describe("collectDoctorChecks", () => {
  test("a healthy development checkout has no failures", async () => {
    const checks = await collectDoctorChecks(makeDeps());
    expect(checks.filter((check) => check.status === "fail")).toEqual([]);
  });

  test("collects every problem in one pass instead of stopping at the first", async () => {
    const checks = await collectDoctorChecks(
      makeDeps({
        nodeVersion: "v20.0.0",
        envFile: null,
        execCommand: async () => ({ code: null, output: "" }),
        freeDiskBytes: async () => 1024 ** 3,
      }),
    );
    const failures = checks.filter((check) => check.status === "fail").map((check) => check.name);
    expect(failures).toContain("node");
    expect(failures).toContain("config");
    expect(failures).toContain("docker");
    expect(failures).toContain("disk");
    expect(failures.length).toBeGreaterThanOrEqual(4);
  });

  test("placeholder secrets outside development fail closed", async () => {
    const deps = makeDeps();
    deps.envFile!.values.NODE_ENV = "production";
    deps.envFile!.values.BETTER_AUTH_SECRET = "eveland-dev-better-auth-secret-0000";
    const checks = await collectDoctorChecks(deps);
    const check = byName(checks, "placeholder-secrets");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("BETTER_AUTH_SECRET");
  });

  test("placeholder secrets under NODE_ENV=development are fine", async () => {
    const deps = makeDeps();
    deps.envFile!.values.BETTER_AUTH_SECRET = "eveland-dev-better-auth-secret-0000";
    const checks = await collectDoctorChecks(deps);
    expect(byName(checks, "placeholder-secrets")?.status).toBe("ok");
  });

  test("an unset NODE_ENV warns that the platform fails closed", async () => {
    const deps = makeDeps();
    delete deps.envFile!.values.NODE_ENV;
    const checks = await collectDoctorChecks(deps);
    expect(byName(checks, "node-env")?.status).toBe("warn");
    expect(byName(checks, "node-env")?.detail).toContain("fails closed");
  });

  test("a foreign listener on the platform block warns about the coming collision", async () => {
    const checks = await collectDoctorChecks(
      makeDeps({
        tcpProbe: async (_host, port) => port === WEB_PORT,
      }),
    );
    const check = byName(checks, "ports");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain(String(WEB_PORT));
  });

  test("infra containers listening while the platform is down are not foreign", async () => {
    const checks = await collectDoctorChecks(
      makeDeps({
        tcpProbe: async (_host, port) => port === POSTGRES_HOST_PORT,
      }),
    );
    expect(byName(checks, "ports")?.status).toBe("ok");
  });

  test("a loopback-only service reachable off-host is a hard failure", async () => {
    const checks = await collectDoctorChecks(
      makeDeps({
        nonLoopbackAddresses: () => ["192.168.1.10"],
        tcpProbe: async (host, port) => host === "192.168.1.10" && port === POSTGRES_HOST_PORT,
      }),
    );
    const check = byName(checks, "loopback-exposure");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("192.168.1.10");
  });

  test("the API's Collector listener on the Docker bridge is not an exposure", async () => {
    // The Linux production form binds it on purpose. docker0 only reaches
    // this list once something attaches to the default bridge network (libuv
    // omits interfaces that are not UP|RUNNING), so without the exemption a
    // correct install fails doctor intermittently — which is exactly the kind
    // of finding that teaches operators to ignore doctor.
    const checks = await collectDoctorChecks(
      makeDeps({
        nonLoopbackAddresses: () => ["172.17.0.1", "192.168.1.10"],
        dockerBridgeHost: async () => "172.17.0.1",
        tcpProbe: async (host, port) => host === "172.17.0.1" && port === API_PORT,
      }),
    );
    const check = byName(checks, "loopback-exposure");
    expect(check?.status).toBe("ok");
    expect(check?.detail).toContain("172.17.0.1");
  });

  test("the exemption is the API's port on the bridge and nothing else", async () => {
    // Postgres or the Dashboard on the very same bridge address is still a
    // finding: containers on that bridge would reach them too.
    const checks = await collectDoctorChecks(
      makeDeps({
        nonLoopbackAddresses: () => ["172.17.0.1"],
        dockerBridgeHost: async () => "172.17.0.1",
        tcpProbe: async (host, port) => host === "172.17.0.1" && port === POSTGRES_HOST_PORT,
      }),
    );
    const check = byName(checks, "loopback-exposure");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("Postgres");
  });

  test("proxy variables warn with the Lima lesson", async () => {
    const checks = await collectDoctorChecks(
      makeDeps({ env: { HTTPS_PROXY: "http://10.0.0.1:7890" } }),
    );
    expect(byName(checks, "proxy-env")?.status).toBe("warn");
  });

  test("a global libvips without SHARP_IGNORE_GLOBAL_LIBVIPS warns on macOS", async () => {
    const checks = await collectDoctorChecks(
      makeDeps({
        fileExists: async (filePath) => filePath === "/opt/homebrew/include/vips",
      }),
    );
    expect(byName(checks, "sharp-libvips")?.status).toBe("warn");
  });

  test("a database with no migration journal names the hijack, not just the migration", async () => {
    // Something answering on the platform's Postgres port proves only that a
    // Postgres is there. A Lima VM port-forward hijack and another project's
    // cluster both look exactly like a fresh database from outside.
    const checks = await collectDoctorChecks(
      makeDeps({ pgJournalProbe: async () => ({ status: "unmigrated" }) }),
    );
    const check = byName(checks, "postgres");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("db:migrate");
    expect(check?.detail).toContain("Lima");
  });

  test("an unreachable database fails with the reason, and never echoes the DSN", async () => {
    const checks = await collectDoctorChecks(
      makeDeps({
        envFile: {
          path: "/repo/.env",
          values: {
            NODE_ENV: "development",
            DATABASE_URL: "postgres://eveland:s3cr3t@db.internal:6543/eveland",
            APP_SECRET_KEY: "k".repeat(32),
            BETTER_AUTH_SECRET: "s".repeat(32),
            EVELAND_ADMIN_PASSWORD: "long-enough-password",
          },
        },
        pgJournalProbe: async () => ({ status: "unreachable", detail: "connection refused" }),
      }),
    );
    const check = byName(checks, "postgres");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("db.internal:6543");
    expect(check?.detail).toContain("connection refused");
    expect(check?.detail).not.toContain("s3cr3t");
  });

  test("pg_dump is only required of an installation that brought its own PostgreSQL", async () => {
    // The bundled database is dumped inside its own container, at a version
    // that matches by construction.
    const missingPgDump = async (argv: string[]) => {
      if (argv[0] === "pg_dump") return { code: null, output: "" };
      if (argv[0] === "pnpm") return { code: 0, output: "11.7.0\n" };
      if (argv[0] === "docker") return { code: 0, output: "27.0\n" };
      return { code: 0, output: "Info-ZIP" };
    };

    expect(
      byName(await collectDoctorChecks(makeDeps({ execCommand: missingPgDump })), "pg_dump"),
    ).toBeUndefined();

    const external = await collectDoctorChecks(
      makeDeps({ database: "external", execCommand: missingPgDump }),
    );
    expect(byName(external, "pg_dump")?.status).toBe("fail");
    expect(byName(external, "pg_dump")?.detail).toContain("eveland-ctl update");
  });

  test("a broken pinned EVELAND_NODE is reported with the nvm-uninstall hint", async () => {
    const deps = makeDeps({
      execCommand: async (argv) => {
        if (argv[0] === "/opt/eveland/node/bin/node") return { code: null, output: "ENOENT" };
        if (argv[0] === "pnpm") return { code: 0, output: "11.7.0\n" };
        if (argv[0] === "docker") return { code: 0, output: "27.0\n" };
        return { code: 0, output: "Info-ZIP" };
      },
    });
    deps.envFile!.values.EVELAND_NODE = "/opt/eveland/node/bin/node";
    const checks = await collectDoctorChecks(deps);
    const check = byName(checks, "pinned-node");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("nvm uninstall");
  });

  test("busybox unzip warns because zip import needs Info-ZIP", async () => {
    const checks = await collectDoctorChecks(
      makeDeps({
        execCommand: async (argv) => {
          if (argv[0] === "unzip") return { code: 1, output: "BusyBox v1.36 multi-call binary" };
          if (argv[0] === "pnpm") return { code: 0, output: "11.7.0\n" };
          if (argv[0] === "docker" && argv[1] === "info") return { code: 0, output: "27.0\n" };
          return { code: 0, output: "" };
        },
      }),
    );
    expect(byName(checks, "unzip")?.status).toBe("warn");
  });

  test("with the supervisor up, failing health probes are a failure", async () => {
    const checks = await collectDoctorChecks(
      makeDeps({
        supervisorRunning: true,
        fetchImpl: async () => new Response("down", { status: 503 }),
      }),
    );
    expect(byName(checks, "platform")?.status).toBe("fail");
  });

  test("WSL2 is treated as Linux and noted", async () => {
    const checks = await collectDoctorChecks(
      makeDeps({
        platform: "linux",
        readTextFile: async (filePath) =>
          filePath === "/proc/version" ? "Linux version 6.6.0-microsoft-standard-WSL2" : null,
      }),
    );
    expect(byName(checks, "os")?.detail).toContain("WSL2");
  });
});
