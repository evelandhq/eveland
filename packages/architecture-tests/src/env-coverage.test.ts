import { describe, expect, test } from "vitest";
import { listSourceFiles, readSource } from "./scan-support.js";

// Platform apps must register every EVELAND_* variable they read in the
// configuration registry, so /internal/diagnostics/config and the operator
// reference stay complete. (The registry -> docs direction is enforced by
// packages/core/src/config-diagnostics-docs.test.ts; this closes the
// source -> registry direction.)
const ENV_READ_PATTERN = /process\.env(?:\.([A-Z0-9_]+)|\[\s*["']([A-Z0-9_]+)["']\s*\])/g;

function registryNames(): Set<string> {
  // Deliberately broad: any SCREAMING_SNAKE string literal in the registry
  // module counts as registered (entry(), urlEntry(), and multi-line forms
  // all match). A stray mention could hide a gap, but the registry file only
  // names variables it defines.
  const source = readSource("packages/core/src/config-diagnostics.ts");
  const names = new Set<string>();
  for (const match of source.matchAll(/"([A-Z][A-Z0-9_]{2,})"/g)) names.add(match[1]!);
  return names;
}

describe("configuration registry coverage", () => {
  test("every EVELAND_* variable a platform app reads is registered", () => {
    const registered = registryNames();
    const unregistered = new Set<string>();
    for (const app of ["apps/api", "apps/gateway", "apps/worker", "apps/web"]) {
      for (const file of listSourceFiles(`${app}/src`)) {
        for (const match of readSource(file).matchAll(ENV_READ_PATTERN)) {
          const name = match[1] ?? match[2]!;
          if (name.startsWith("EVELAND_") && !registered.has(name)) {
            unregistered.add(`${name} (${file})`);
          }
        }
      }
    }
    expect([...unregistered].sort()).toEqual([]);
  });
});
