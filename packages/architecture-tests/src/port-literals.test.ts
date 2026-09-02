import { describe, expect, test } from "vitest";
import { listSourceFiles, listWorkspaces, readSource } from "./scan-support.js";

/**
 * Port-literal ratchet: every default port the platform binds or dials lives
 * in @evelandhq/core/ports, and product code must import it from there. Bare
 * literals are how the pre-17300 defaults (3000/4000/4080/5432/...) crept
 * into a dozen files each — and how a collision becomes a silent
 * wrong-service connection instead of a startup failure (#167). The scan
 * covers the retired legacy ports too, so none of them can creep back in.
 */
const PORT_LITERAL =
  /(?<!\d)(3000|3001|4000|4080|4090|4317|4318|4327|4328|5432|41000|55432|17300|17301|17302|17303|17310|17311|17312|17313|17314|17350|18000)(?!\d)/;

const EXEMPT_FILES = new Set([
  // The single source of truth these literals are required to live in.
  "packages/core/src/ports.ts",
]);

/** Smoke/e2e harnesses pin environment-specific fixture addresses (for
 * example a natively installed PostgreSQL on its stock 5432). */
const EXEMPT_DIRECTORIES = [/\/integration\//];

/**
 * Ports the platform has retired. The scan above reaches product sources only,
 * and `4000` outlived the 17300 move inside `docker-compose.yml` because
 * nothing checked deployment configuration -- long enough to send every Agent
 * event to a port no service listens on (#462). Current ports are legitimate
 * here (a Compose file is where they are declared), so only retired values are
 * a finding.
 */
const RETIRED_PORT = /(?<!\d)(3000|3001|4000|4080|4090|41000|55432)(?!\d)/;

const DEPLOYMENT_CONFIGURATION = [
  "docker-compose.yml",
  "docker-compose.native-linux.yml",
  "docker-compose.prod.yml",
  ".env.example",
  "infra/otel/collector.yaml",
  "infra/traefik/agents.yml",
  "infra/lima/eveland.yaml",
  "infra/systemd/eveland-worker.service",
  "infra/systemd/eveland-worker.env.example",
  "infra/systemd/eveland-workflow-dispatcher.service",
  "infra/systemd/eveland-workflow-dispatcher.env.example",
];

describe("port literals", () => {
  test("product code imports ports from @evelandhq/core/ports instead of repeating literals", () => {
    const violations: string[] = [];
    for (const workspace of listWorkspaces()) {
      for (const file of listSourceFiles(`${workspace.directory}/src`)) {
        if (EXEMPT_FILES.has(file)) continue;
        if (EXEMPT_DIRECTORIES.some((pattern) => pattern.test(file))) continue;
        const lines = readSource(file).split("\n");
        for (const [index, line] of lines.entries()) {
          if (PORT_LITERAL.test(line)) violations.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  test("deployment configuration carries no retired platform port", () => {
    const violations: string[] = [];
    for (const file of DEPLOYMENT_CONFIGURATION) {
      const lines = readSource(file).split("\n");
      for (const [index, line] of lines.entries()) {
        if (RETIRED_PORT.test(line)) violations.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
