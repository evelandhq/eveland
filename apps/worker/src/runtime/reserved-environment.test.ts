import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_SECRET_ENV_NAME } from "@evelandhq/workflow-world";
import { describe, expect, test } from "vitest";

import {
  DEPLOYMENT_LAUNCH_ENVIRONMENT_KEYS,
  RESERVED_RUNTIME_ENVIRONMENT_KEYS,
} from "./reserved-environment.js";

// The names the shared World owns: its `WORKFLOW_WORLD_*` vocabulary, plus any
// `EVELAND_*` name it might read. Each one decides tenancy, topology, or
// dispatch authentication for the deployed process.
const WORLD_OWNED_NAME = /\b(?:WORKFLOW_WORLD|EVELAND)_[A-Z0-9_]+\b/g;
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/**
 * Every file the deployed process loads from the World's root export, found by
 * following relative imports from the entry. The dispatcher subpath is a
 * separate process and is deliberately not reached from here.
 */
function worldRuntimeModules(): string[] {
  const entry = fileURLToPath(import.meta.resolve("@evelandhq/workflow-world"));
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = stripComments(readFileSync(file, "utf8"));
    for (const match of source.matchAll(RELATIVE_IMPORT)) {
      pending.push(path.resolve(path.dirname(file), match[1]!));
    }
  }
  return [...seen];
}

describe("the shared World's environment names", () => {
  // A name the World reads that the platform does not own is a name a project
  // entry can set: WORKFLOW_WORLD_TENANT_ID would scope the Deployment's runs
  // into another tenant's partitions, WORKFLOW_WORLD_RUNTIME_SECRET would fail
  // every dispatch.
  test("every name the installed World reads at runtime is platform-owned", () => {
    const read = new Set<string>([RUNTIME_SECRET_ENV_NAME]);
    for (const file of worldRuntimeModules()) {
      for (const match of stripComments(readFileSync(file, "utf8")).matchAll(WORLD_OWNED_NAME)) {
        read.add(match[0]);
      }
    }
    // Guards the scan itself: an empty result would pass vacuously.
    expect(read).toContain("WORKFLOW_WORLD_TENANT_ID");

    const owned = new Set([
      ...RESERVED_RUNTIME_ENVIRONMENT_KEYS,
      ...DEPLOYMENT_LAUNCH_ENVIRONMENT_KEYS,
    ]);
    expect([...read].filter((name) => !owned.has(name)).sort()).toEqual([]);
  });
});
