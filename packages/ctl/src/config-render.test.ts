import { describe, expect, test } from "vitest";
import {
  databaseDefaults,
  defaultBootstrapInputs,
  deriveAgentBaseDomains,
  renderPlatformEnv,
  type BootstrapInputs,
} from "./config-render.ts";
import { parseEnvFile } from "./env-file.ts";

const PLATFORM_DB = "postgres://eveland:secret@db.internal:5432/eveland";
const WORLD_DB = "postgres://eveland:secret@db.internal:5432/eveland_workflow";

const INPUTS: BootstrapInputs = {
  publicOrigin: "http://localhost:17300",
  adminEmail: "admin@example.com",
  adminPassword: "a-long-enough-password",
  databaseUrl: PLATFORM_DB,
  workflowWorldUrl: WORLD_DB,
};

function render(platform: "darwin" | "linux", inputs = INPUTS) {
  return renderPlatformEnv({ platform, applianceRoot: "/opt/eveland", inputs });
}

describe("renderPlatformEnv", () => {
  test("the rendered file parses back to exactly the returned values", () => {
    const { content, values } = render("darwin");
    expect(parseEnvFile(content)).toEqual(values);
  });

  test("every value is quoted, so Compose cannot interpolate a password away", () => {
    // Compose expands `$NAME` inside an unquoted --env-file value while the
    // host's readers take it literally: the containerized API would receive a
    // truncated DSN and the Worker the real one, which is the split this whole
    // topology exists to remove.
    const dollar = "postgres://eveland:pa$WORD@db.internal:5432/eveland";
    const { content, values } = render("linux", { ...INPUTS, databaseUrl: dollar });
    expect(content).toContain(`DATABASE_URL='${dollar}'`);
    expect(parseEnvFile(content).DATABASE_URL).toBe(dollar);
    expect(values.DATABASE_URL).toBe(dollar);
  });

  test("a value carrying a single quote is refused rather than written", () => {
    // Compose rejects the whole file, not just that line, so there is no
    // encoding to fall back to — and a half-read env file is a worse failure.
    expect(() => render("linux", { ...INPUTS, adminPassword: "pa'ssword-long-enough" })).toThrow(
      /single quote/,
    );
  });

  test("covers the decide-per-install set with no placeholder secrets", () => {
    const { values } = render("darwin");
    for (const key of [
      "NODE_ENV",
      // EVELAND_RELEASE_CHANNEL / EVELAND_REVISION are derived from the
      // checkout at boot/update, never rendered as static values.
      "EVELAND_PUBLIC_ORIGIN",
      "EVELAND_AGENT_BASE_DOMAINS",
      "DATABASE_URL",
      "EVELAND_WORKFLOW_WORLD_URL",
      "WORKFLOW_DISPATCHER_ACTIVATION_API_URL",
      "WORKFLOW_DISPATCHER_ACTIVATION_TOKEN",
      "APP_SECRET_KEY",
      "BETTER_AUTH_SECRET",
      "EVELAND_ADMIN_EMAIL",
      "EVELAND_ADMIN_PASSWORD",
      "EVELAND_DATA_DIR",
      "EVELAND_OTLP_SERVICE_TOKEN",
      "EVELAND_GATEWAY_SERVICE_TOKEN",
      "EVELAND_GATEWAY_AFFINITY_SECRET",
      "EVELAND_SCHEDULER_RUNTIME_SECRET",
      "EVELAND_SCHEDULER_DISPATCH_SECRET",
      "EVELAND_SCHEDULER_REDEEM_URL",
      "EVELAND_RUNTIME",
    ]) {
      expect(values[key], key).toBeTruthy();
    }
    expect(values.NODE_ENV).toBe("production");
    for (const [key, value] of Object.entries(values)) {
      expect(value.startsWith("eveland-dev-"), `${key} must not be a placeholder`).toBe(false);
    }
  });

  test("both database addresses come from the answers, never from a shape ctl invents", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const { values } = render(platform);
      expect(values.DATABASE_URL, platform).toBe(PLATFORM_DB);
      expect(values.EVELAND_WORKFLOW_WORLD_URL, platform).toBe(WORLD_DB);
    }
  });

  test("macOS derives Docker-shaped deployment addresses and the docker runtime", () => {
    const { values } = render("darwin");
    expect(values.EVELAND_RUNTIME).toBe("docker");
    expect(values.EVELAND_SCHEDULER_REDEEM_URL).toContain("host.docker.internal");
    // Agents reach the world through a name the platform's own host processes
    // cannot resolve, so the platform gets the loopback view of it.
    expect(values.EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL).toBe(PLATFORM_DB);
  });

  test("Linux derives loopback deployment addresses and the systemd runtime", () => {
    const { values } = render("linux");
    expect(values.EVELAND_RUNTIME).toBe("systemd");
    expect(values.EVELAND_SCHEDULER_REDEEM_URL).toContain("127.0.0.1");
    // One external database, one address: nothing here holds a second view.
    expect(values.EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL).toBeUndefined();
  });

  test("the dispatcher activation token IS the gateway service token — the API validates against it", () => {
    const { values } = render("darwin");
    expect(values.WORKFLOW_DISPATCHER_ACTIVATION_TOKEN).toBe(values.EVELAND_GATEWAY_SERVICE_TOKEN);
  });

  test("the scheduler secrets are independent values, as the worker preflight requires", () => {
    const { values } = render("darwin");
    expect(values.EVELAND_SCHEDULER_RUNTIME_SECRET).not.toBe(
      values.EVELAND_SCHEDULER_DISPATCH_SECRET,
    );
    expect(values.EVELAND_SCHEDULER_RUNTIME_SECRET!.length).toBeGreaterThanOrEqual(32);
    expect(values.EVELAND_SCHEDULER_DISPATCH_SECRET!.length).toBeGreaterThanOrEqual(32);
  });

  test("every generated secret differs from every other", () => {
    const { values } = render("darwin");
    const secrets = [
      values.APP_SECRET_KEY,
      values.BETTER_AUTH_SECRET,
      values.EVELAND_OTLP_SERVICE_TOKEN,
      values.EVELAND_GATEWAY_SERVICE_TOKEN,
      values.EVELAND_GATEWAY_AFFINITY_SECRET,
      values.EVELAND_SCHEDULER_RUNTIME_SECRET,
      values.EVELAND_SCHEDULER_DISPATCH_SECRET,
    ];
    expect(new Set(secrets).size).toBe(secrets.length);
  });

  test("EVELAND_DATA_DIR is an absolute path under the appliance root", () => {
    const { values } = render("linux");
    expect(values.EVELAND_DATA_DIR).toBe("/opt/eveland/data");
  });

  test("model keys are rendered only when provided", () => {
    const without = render("darwin");
    expect(without.values.ANTHROPIC_API_KEY).toBeUndefined();
    const withKeys = render("darwin", {
      ...INPUTS,
      anthropicApiKey: "sk-ant-test",
    });
    expect(withKeys.values.ANTHROPIC_API_KEY).toBe("sk-ant-test");
  });
});

describe("deriveAgentBaseDomains", () => {
  test("localhost origins map to agent.localhost, real domains to agent.<domain>", () => {
    expect(deriveAgentBaseDomains("http://localhost:17300")).toBe("agent.localhost");
    expect(deriveAgentBaseDomains("http://127.0.0.1:17300")).toBe("agent.localhost");
    expect(deriveAgentBaseDomains("https://eveland.example.com")).toBe("agent.eveland.example.com");
  });
});

describe("databaseDefaults", () => {
  test("the Compose form offers the database it supervises, in the Agents' view", () => {
    const macos = databaseDefaults("darwin", "compose");
    expect(macos.databaseUrl).toBe("postgres://eveland:eveland@127.0.0.1:17310/eveland");
    // Agents run in Docker on macOS and reach the host by this name.
    expect(macos.workflowWorldUrl).toBe(
      "postgres://eveland:eveland@host.docker.internal:17310/eveland",
    );

    // The ctl supervisor on Linux runs Agents as host units, so one loopback
    // address serves the platform and the Agents alike.
    const linux = databaseDefaults("linux", "compose");
    expect(linux.databaseUrl).toBe("postgres://eveland:eveland@127.0.0.1:17310/eveland");
    expect(linux.workflowWorldUrl).toBe("postgres://eveland:eveland@127.0.0.1:17310/eveland");
  });

  test("the external form offers nothing: an invented address is worse than a question", () => {
    // Its API is on the Compose bridge while the worker, the dispatcher and
    // every Deployment are on the host. A loopback default is undialable from
    // the bridge, and one that happens to answer proves nothing about which
    // cluster is behind it.
    expect(databaseDefaults("linux", "external")).toEqual({});
  });

  test("the form decides, not the OS — Linux is on both sides of it", () => {
    // `eveland-ctl start --foreground` on Linux runs every platform process on
    // the host, exactly like macOS; keying the defaults off the OS left that
    // form with no answer to a question it should never have been asked.
    expect(databaseDefaults("linux", "compose").databaseUrl).toBeDefined();
    expect(databaseDefaults("linux", "external").databaseUrl).toBeUndefined();
  });
});

describe("defaultBootstrapInputs", () => {
  test("the external form takes both addresses from the environment an install exports", () => {
    const defaults = defaultBootstrapInputs(
      { DATABASE_URL: PLATFORM_DB, EVELAND_WORKFLOW_WORLD_URL: WORLD_DB },
      "linux",
      "external",
    );
    expect(defaults.databaseUrl).toBe(PLATFORM_DB);
    expect(defaults.workflowWorldUrl).toBe(WORLD_DB);
  });

  test("the external form leaves them unanswered when the environment carries none", () => {
    const defaults = defaultBootstrapInputs({}, "linux", "external");
    expect(defaults.databaseUrl).toBeUndefined();
    expect(defaults.workflowWorldUrl).toBeUndefined();
  });

  test("the Compose form ignores the environment: ctl starts the database it named", () => {
    // An address from the shell would point the platform elsewhere while ctl
    // still brings up its own Compose Postgres.
    for (const platform of ["darwin", "linux"] as const) {
      const defaults = defaultBootstrapInputs(
        { DATABASE_URL: PLATFORM_DB, EVELAND_WORKFLOW_WORLD_URL: WORLD_DB },
        platform,
        "compose",
      );
      expect(defaults.databaseUrl, platform).toBe(
        databaseDefaults(platform, "compose").databaseUrl,
      );
      expect(defaults.workflowWorldUrl, platform).toBe(
        databaseDefaults(platform, "compose").workflowWorldUrl,
      );
    }
  });
});
