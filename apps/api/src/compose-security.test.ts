import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
    expect(serviceBlock(productionCompose, "worker")).toContain("/var/run/docker.sock");
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
    expect(api).toContain("BETTER_AUTH_URL: ${BETTER_AUTH_URL:-http://localhost:4000}");
  });
});

describe("Compose production runtime environment", () => {
  it("runs the production web build and server under NODE_ENV=production", () => {
    const web = serviceBlock(productionCompose, "web");

    // The base file's NODE_ENV=development merges into the production web service,
    // so both steps need an explicit override on the command.
    expect(web).toContain("NODE_ENV=production pnpm --filter @eveland/web build");
    expect(web).toContain("NODE_ENV=production pnpm --filter @eveland/web exec next start");

    // Never container-wide: NODE_ENV=production makes `pnpm install` skip the
    // devDependencies the Next build needs (see the overlay header comment).
    expect(web).not.toContain("NODE_ENV:");
  });
});
