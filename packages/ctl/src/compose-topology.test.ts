import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { API_PORT } from "@evelandhq/core/ports";
import { describe, expect, test } from "vitest";
import { renderApplianceOverlay } from "./systemd-mode.js";

/**
 * The Observation path crosses a Compose boundary: the Collector holds every
 * Agent event until the API accepts it. Whether it can is decided by the
 * *merged* configuration, never by one file — the appliance renders a third
 * overlay on top of the production one, and a substring assertion against a
 * single file passes while the rendered stack is unreachable (#462).
 *
 * So this ratchet merges the real files with `docker compose config`, which is
 * the only implementation of Compose merge semantics, and asserts the base,
 * host-native, production, and rendered appliance forms exercised here.
 */
const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const baseCompose = path.join(repositoryRoot, "docker-compose.yml");
const productionCompose = path.join(repositoryRoot, "docker-compose.prod.yml");
const nativeCompose = path.join(repositoryRoot, "docker-compose.native.yml");

/** Placeholders for the `:?set X` variables, so `config` can resolve. */
const requiredEnv = {
  EVELAND_PUBLIC_ORIGIN: "http://localhost:17300",
  EVELAND_AGENT_BASE_DOMAINS: "agent.localhost",
  EVELAND_HOST_DATA_DIR: "/tmp/eveland-compose-topology",
  BETTER_AUTH_SECRET: "compose-topology-better-auth-secret",
  EVELAND_ADMIN_PASSWORD: "compose-topology-admin",
  APP_SECRET_KEY: "compose-topology-app-secret",
  EVELAND_OTLP_SERVICE_TOKEN: "compose-topology-otlp",
  EVELAND_GATEWAY_SERVICE_TOKEN: "compose-topology-gateway",
  EVELAND_GATEWAY_AFFINITY_SECRET: "compose-topology-affinity",
  EVELAND_SCHEDULER_RUNTIME_SECRET: "compose-topology-runtime",
  EVELAND_SCHEDULER_DISPATCH_SECRET: "compose-topology-dispatch",
};

const scratchDirectory = mkdtempSync(path.join(os.tmpdir(), "eveland-compose-topology-"));

/**
 * Compose interpolates from the caller's environment first and the project's
 * `.env` second, and this ratchet must see neither: a developer's shell or
 * `.env` can still carry an earlier port layout, and a merged configuration
 * that resolves only because of such values proves nothing about the shipped
 * files. The CLI therefore runs with just what it needs to find the Docker
 * daemon, and reads the placeholders from an explicit env file instead of the
 * repository's `.env`.
 */
const composeCliEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  USER: process.env.USER,
  TMPDIR: process.env.TMPDIR,
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("DOCKER_"))),
};
const placeholderEnvFile = path.join(scratchDirectory, "compose-topology.env");
writeFileSync(
  placeholderEnvFile,
  Object.entries(requiredEnv)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n") + "\n",
  "utf8",
);

type ComposePort = { host_ip?: string; published?: string; target?: number };
type ComposeService = {
  network_mode?: string;
  networks?: Record<string, unknown>;
  ports?: ComposePort[];
  environment?: Record<string, string>;
};
type ComposeConfig = { services: Record<string, ComposeService> };

function requiredService(config: ComposeConfig, name: string): ComposeService {
  const service = config.services[name];
  if (!service) throw new Error(`Merged Compose configuration has no ${name} service.`);
  return service;
}

function mergedConfig(files: string[]): ComposeConfig {
  const stdout = execFileSync(
    "docker",
    [
      "compose",
      "--env-file",
      placeholderEnvFile,
      ...files.flatMap((file) => ["-f", file]),
      "config",
      "--format",
      "json",
    ],
    {
      cwd: repositoryRoot,
      env: composeCliEnv,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout) as ComposeConfig;
}

function applianceOverlayPath(): string {
  const dataDir = "/opt/eveland/data";
  const file = path.join(scratchDirectory, "compose.appliance.yml");
  writeFileSync(
    file,
    renderApplianceOverlay({
      dataDir,
      publicOrigin: "https://eveland.example.com",
      envFilePath: "/opt/eveland/etc/eveland.env",
      gatewayEnvFilePath: "/opt/eveland/etc/eveland-gateway.env",
      webEnvFilePath: "/opt/eveland/etc/eveland-web.env",
    }),
    "utf8",
  );
  return file;
}

function sharedNetworks(left: ComposeService, right: ComposeService): string[] {
  const rightNetworks = new Set(Object.keys(right.networks ?? {}));
  return Object.keys(left.networks ?? {}).filter((network) => rightNetworks.has(network));
}

// A missing Compose CLI must not quietly retire the guard: skip on a
// workstation without Docker, and let CI fail loudly instead.
const composeCliAvailable = (() => {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!composeCliAvailable && !process.env.CI)(
  "the merged Compose topology reaches the API from the Collector",
  () => {
    const forms = {
      development: () => mergedConfig([baseCompose]),
      production: () => mergedConfig([baseCompose, productionCompose]),
      appliance: () => mergedConfig([baseCompose, productionCompose, applianceOverlayPath()]),
    };

    for (const [form, resolve] of Object.entries(forms)) {
      describe(form, () => {
        test("the Collector and the API share a network", () => {
          const config = resolve();
          const api = requiredService(config, "api");
          const collector = requiredService(config, "otel-collector");

          // Host networking has no Compose service DNS, so an API in the host
          // namespace is only dialable through the host gateway -- which
          // cannot reach the loopback publish the network contract requires.
          expect(api.network_mode).toBeUndefined();
          expect(sharedNetworks(api, collector)).not.toEqual([]);
        });

        test("the Collector's exporters address the API by service name", () => {
          const collector = requiredService(resolve(), "otel-collector").environment ?? {};

          expect(collector.EVELAND_BUILTIN_OTLP_ENDPOINT).toBe(
            `http://api:${API_PORT}/internal/otel`,
          );
          expect(collector.EVELAND_EXTERNAL_OTLP_PROXY_ENDPOINT).toBe(
            `http://api:${API_PORT}/internal/observability/destinations`,
          );
        });

        test("the API binds every interface inside its container", () => {
          // Container-internal, not a host exposure: a container that binds
          // loopback in its own namespace cannot be reached through a
          // published port at all.
          expect(requiredService(resolve(), "api").environment?.EVELAND_API_BIND_HOST).toBe(
            "0.0.0.0",
          );
        });

        test("the API publishes its port to host loopback only", () => {
          const published = requiredService(resolve(), "api").ports ?? [];

          expect(published.map((port) => port.published)).toContain(String(API_PORT));
          for (const port of published) expect(port.host_ip).toBe("127.0.0.1");
        });
      });
    }

    test("the front door keeps the host network in production", () => {
      // The Agent Gateway reaches Deployments on the host's 127.0.0.1:18xxx
      // and is the installation's only non-loopback listener; moving the API
      // off host networking must not move it too.
      expect(requiredService(forms.production(), "gateway").network_mode).toBe("host");
      expect(requiredService(forms.appliance(), "gateway").network_mode).toBe("host");
    });

    test("no production form starts a second Worker or workflow dispatcher", () => {
      // Both are host systemd units, and exactly one of each may drive an
      // installation. The base file's development Worker and dispatcher carry
      // no profile, so deleting the overlay blocks that gate them -- rather
      // than reducing each to a `profiles:` entry -- silently returns a second
      // controller to the merged production configuration.
      for (const form of [forms.production(), forms.appliance()]) {
        expect(Object.keys(form.services)).not.toContain("worker");
        expect(Object.keys(form.services)).not.toContain("workflow-dispatcher");
      }
    });

    describe("host native", () => {
      const resolve = () => mergedConfig([baseCompose, nativeCompose]);

      test("the Collector stays on its bridge for Docker Agent telemetry", () => {
        expect(requiredService(resolve(), "otel-collector").network_mode).toBeUndefined();
      });

      test("the Collector exporters address the API through the host gateway", () => {
        const collector = requiredService(resolve(), "otel-collector").environment ?? {};

        expect(collector.EVELAND_BUILTIN_OTLP_ENDPOINT).toBe(
          `http://host.docker.internal:${API_PORT}/internal/otel`,
        );
        expect(collector.EVELAND_EXTERNAL_OTLP_PROXY_ENDPOINT).toBe(
          `http://host.docker.internal:${API_PORT}/internal/observability/destinations`,
        );
      });
    });
  },
);
