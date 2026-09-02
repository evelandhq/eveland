import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { API_PORT } from "@evelandhq/core/ports";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const developmentCompose = readFileSync(resolve(repositoryRoot, "docker-compose.yml"), "utf8");
const productionCompose = readFileSync(resolve(repositoryRoot, "docker-compose.prod.yml"), "utf8");

function serviceBlock(compose: string, service: string) {
  const marker = `\n  ${service}:\n`;
  const start = compose.indexOf(marker);

  if (start === -1) {
    throw new Error(`Compose service ${service} was not found`);
  }

  const contentStart = start + marker.length;
  const nextServiceOffset = compose.slice(contentStart).search(/\n  [a-z][a-z0-9-]*:\n/);
  return compose.slice(
    start,
    nextServiceOffset === -1 ? undefined : contentStart + nextServiceOffset,
  );
}

describe("Compose controller security boundaries", () => {
  it("grants the Docker controller socket only to the worker", () => {
    expect(serviceBlock(developmentCompose, "api")).not.toContain("/var/run/docker.sock");
    expect(serviceBlock(productionCompose, "api")).not.toContain("/var/run/docker.sock");
    expect(serviceBlock(developmentCompose, "gateway")).not.toContain("/var/run/docker.sock");
    expect(serviceBlock(productionCompose, "gateway")).not.toContain("/var/run/docker.sock");

    expect(serviceBlock(developmentCompose, "worker")).toContain("/var/run/docker.sock");

    // Production holds no Docker controller privilege at all: Agents are
    // systemd units driven by the host Worker, so no container in the overlay
    // may carry the daemon socket -- not even a Worker.
    expect(productionCompose).not.toContain("/var/run/docker.sock");
  });

  it("masks deployment source and secret data from the Gateway", () => {
    const gateway = serviceBlock(developmentCompose, "gateway");

    expect(gateway).toContain("eveland-gateway-data-mask:/workspace/.eveland-data");
    expect(gateway).not.toContain("/var/lib/eveland");
    expect(serviceBlock(productionCompose, "gateway")).not.toContain("/var/lib/eveland");
  });

  it("requires Better Auth and initial admin secrets explicitly", () => {
    const api = serviceBlock(developmentCompose, "api");

    expect(api).toContain("EVELAND_ADMIN_EMAIL: ${EVELAND_ADMIN_EMAIL:-admin@example.com}");
    expect(api).toContain(
      'EVELAND_ADMIN_PASSWORD: "${EVELAND_ADMIN_PASSWORD:?set EVELAND_ADMIN_PASSWORD}"',
    );
    expect(api).toContain('BETTER_AUTH_SECRET: "${BETTER_AUTH_SECRET:?set BETTER_AUTH_SECRET}"');
    expect(api).toContain(
      "EVELAND_PUBLIC_ORIGIN: ${EVELAND_PUBLIC_ORIGIN:-http://localhost:17300}",
    );
  });
});

describe("Compose production runtime environment", () => {
  it("gates the development workflow dispatcher out of the production stack", () => {
    // Exactly one dispatcher per installation: production uses the host systemd
    // service, so the overlay must keep the base file's development dispatcher
    // behind a profile the documented production command never enables.
    expect(serviceBlock(productionCompose, "workflow-dispatcher")).toContain(
      'profiles: ["dev-dispatcher"]',
    );

    // The base file stays profile-free so plain `docker compose up` runs it in dev.
    expect(serviceBlock(developmentCompose, "workflow-dispatcher")).not.toContain("profiles:");
  });

  it("gates the development Worker out of the production stack", () => {
    // The host systemd Worker is production's only runtime controller. The base
    // file's Worker carries no profile, so the overlay must reduce it to a
    // profile gate rather than delete the block: deleting it would let the
    // merged production configuration start a second, Docker-runtime one.
    const worker = serviceBlock(productionCompose, "worker");

    expect(worker).toContain('profiles: ["dev-worker"]');
    expect(worker).not.toContain("EVELAND_RUNTIME");

    // The base file stays profile-free so plain `docker compose up` runs it in dev.
    expect(serviceBlock(developmentCompose, "worker")).not.toContain("profiles:");
  });

  it("runs the production web build and server under NODE_ENV=production", () => {
    const web = serviceBlock(productionCompose, "web");

    // The base file's NODE_ENV=development merges into the production web service,
    // so both steps need an explicit override on the command.
    expect(web).toContain("NODE_ENV=production pnpm --filter @evelandhq/web build");
    expect(web).toContain("NODE_ENV=production pnpm --filter @evelandhq/web exec next start");

    // Never container-wide: NODE_ENV=production makes `pnpm install` skip the
    // devDependencies the Next build needs (see the overlay header comment).
    expect(web).not.toContain("NODE_ENV:");
  });
});

describe("Compose Observation path", () => {
  it("addresses the API by compose service name from the Collector", () => {
    const collector = serviceBlock(developmentCompose, "otel-collector");

    // The Collector holds the only copy of an Agent's events until the API
    // accepts them: a refused connection is retryable and silently fills its
    // persistent queue until capacity runs out, while a 404 from a stale path
    // or port is non-retryable and dropped on the spot. Both endpoints must
    // track API_PORT rather than a literal the next port move leaves behind,
    // and both must name the service: the two containers share this file's
    // network, and routing back out through the host gateway instead only
    // reaches a loopback-published port on macOS.
    expect(collector).toContain(
      `EVELAND_BUILTIN_OTLP_ENDPOINT: http://api:${API_PORT}/internal/otel`,
    );
    expect(collector).toContain(
      `EVELAND_EXTERNAL_OTLP_PROXY_ENDPOINT: http://api:${API_PORT}/internal/observability/destinations`,
    );
  });
});
