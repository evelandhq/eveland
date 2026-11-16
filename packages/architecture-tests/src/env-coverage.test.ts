import { configurationDefinitions } from "@evelandhq/core/config-diagnostics";
import { describe, expect, test } from "vitest";
import { listSourceFiles, listWorkspaces, readSource } from "./scan-support.js";

// Platform code must register every operator-facing EVELAND_* variable it
// reads in the configuration registry, so /internal/diagnostics/config and
// the operator reference stay complete. (The registry -> docs direction is
// enforced by packages/core/src/config-diagnostics-docs.test.ts; this closes
// the source -> registry direction.)
//
// Reads through an injected environment object (`env.X`, `workerEnv.X`,
// `input.env["X"]`) count too: most of the platform takes its environment as
// a parameter so tests can pass one, and those reads are as operator-facing
// as `process.env.X`.
const ENV_READ_PATTERN =
  /(?:\bprocess\.env|\b(?:[A-Za-z_$][\w$]*)?[eE]nv)\??(?:\.([A-Z0-9_]+)|\[\s*["']([A-Z0-9_]+)["']\s*\])/g;

// `const { EVELAND_X } = process.env` reads a variable in a form the pattern
// above cannot attribute; forbid the idiom instead of missing it.
const ENV_DESTRUCTURE_PATTERN = /(?:const|let|var)\s*\{[^}]*\}\s*=\s*process\.env\b/;

// EVELAND_* variables that are NOT operator configuration: the platform
// injects them into Agent processes (or the baked scheduler channel) at
// runtime, and Agent-side code reads them back. They belong to the injection
// contract, not the operator registry. A new package-side EVELAND_* read must
// be classified here or registered -- never silently unscanned.
const PLATFORM_INJECTED_OR_AGENT_SIDE = new Set([
  "EVELAND_ALLOWED_REALM_IDS",
  "EVELAND_DEPLOYMENT_ID",
  "EVELAND_IDENTITY_ISSUER",
  "EVELAND_IDENTITY_JWKS_URL",
  "EVELAND_PROJECT_ID",
  "EVELAND_RUNTIME_INSTANCE_ID",
  "EVELAND_SANDBOX_CACHE_DIR",
  "EVELAND_SANDBOX_RUN_TIMEOUT_MS",
  "EVELAND_SANDBOX_TEMPLATE_REVISION",
  "EVELAND_SCHEDULER_REDEEM_URL",
  "EVELAND_SCHEDULER_RUNTIME_SECRET",
]);

// EVELAND_* variables read by the host tooling rather than a platform
// process: eveland-ctl and the installer that hands over to it. The registry
// describes what each platform component reads; these belong to the operator
// reference's host tooling section (config-diagnostics-docs.test.ts checks
// they are documented), except EVELAND_INSTALL_METHOD, which install.sh sets
// for eveland-ctl itself.
export const HOST_TOOLING = new Set(["EVELAND_HOME", "EVELAND_INSTALL_METHOD"]);

function registryNames(): Set<string> {
  // The registry module itself is the source of truth -- imported, not
  // regexed, so an unregistered name cannot pass by appearing in a comment
  // or unrelated string literal.
  return new Set(configurationDefinitions.map((definition) => definition.name));
}

describe("configuration registry coverage", () => {
  test("every EVELAND_* variable platform code reads is registered or classified as injected", () => {
    const registered = registryNames();
    const unregistered = new Set<string>();
    const destructured: string[] = [];
    for (const workspace of listWorkspaces()) {
      if (workspace.name === "eveland") continue; // the published sdk is agent-side by definition
      for (const file of listSourceFiles(`${workspace.directory}/src`)) {
        const source = readSource(file);
        if (ENV_DESTRUCTURE_PATTERN.test(source)) {
          destructured.push(file);
        }
        for (const match of source.matchAll(ENV_READ_PATTERN)) {
          const name = match[1] ?? match[2]!;
          if (
            name.startsWith("EVELAND_") &&
            !registered.has(name) &&
            !PLATFORM_INJECTED_OR_AGENT_SIDE.has(name) &&
            !HOST_TOOLING.has(name)
          ) {
            unregistered.add(`${name} (${file})`);
          }
        }
      }
    }
    expect(
      destructured,
      "destructuring process.env hides reads from this scan; use process.env.NAME",
    ).toEqual([]);
    expect([...unregistered].sort()).toEqual([]);
  });
});
