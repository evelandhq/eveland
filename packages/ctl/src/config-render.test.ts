import { describe, expect, test } from "vitest";
import {
  deriveAgentBaseDomains,
  renderPlatformEnv,
  type BootstrapInputs,
} from "./config-render.ts";
import { parseEnvFile } from "./env-file.ts";

const INPUTS: BootstrapInputs = {
  publicOrigin: "http://localhost:17300",
  adminEmail: "admin@example.com",
  adminPassword: "a-long-enough-password",
};

function render(platform: "darwin" | "linux", inputs = INPUTS) {
  return renderPlatformEnv({ platform, applianceRoot: "/opt/eveland", inputs });
}

describe("renderPlatformEnv", () => {
  test("the rendered file parses back to exactly the returned values", () => {
    const { content, values } = render("darwin");
    expect(parseEnvFile(content)).toEqual(values);
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

  test("macOS derives Docker-shaped deployment addresses and the docker runtime", () => {
    const { values } = render("darwin");
    expect(values.EVELAND_RUNTIME).toBe("docker");
    expect(values.EVELAND_WORKFLOW_WORLD_URL).toContain("host.docker.internal");
    expect(values.EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL).toContain("127.0.0.1");
    expect(values.EVELAND_SCHEDULER_REDEEM_URL).toContain("host.docker.internal");
  });

  test("Linux derives loopback deployment addresses and the systemd runtime", () => {
    const { values } = render("linux");
    expect(values.EVELAND_RUNTIME).toBe("systemd");
    expect(values.EVELAND_WORKFLOW_WORLD_URL).toContain("127.0.0.1");
    expect(values.EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL).toBeUndefined();
    expect(values.EVELAND_SCHEDULER_REDEEM_URL).toContain("127.0.0.1");
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
    const withKeys = render("darwin", { ...INPUTS, anthropicApiKey: "sk-ant-test" });
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
