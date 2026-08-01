import { describe, expect, test } from "vitest";
import {
  importSpecifiers,
  listWorkspaces,
  readSource,
  resolveRelativeImport,
} from "./scan-support.js";

const NODE_BUILTINS = new Set([
  "assert", "buffer", "child_process", "crypto", "dns", "events", "fs", "http",
  "https", "net", "os", "path", "process", "stream", "tls", "url", "util",
  "worker_threads", "zlib",
]);

function isNodeSpecifier(specifier: string): boolean {
  return specifier.startsWith("node:") || NODE_BUILTINS.has(specifier.split("/")[0]!);
}

describe("browser-safe core exports", () => {
  test("no non-server core export reaches a node builtin", () => {
    const core = listWorkspaces().find((workspace) => workspace.name === "@eveland/core")!;
    const exportsMap = core.manifest.exports as Record<string, string>;
    const violations: string[] = [];

    for (const [subpath, target] of Object.entries(exportsMap)) {
      if (subpath.startsWith("./server/")) continue;
      const entry = `${core.directory}/${target.replace(/^\.\//, "")}`;
      const queue = [entry];
      const seen = new Set<string>(queue);
      while (queue.length > 0) {
        const file = queue.pop()!;
        for (const specifier of importSpecifiers(readSource(file))) {
          if (isNodeSpecifier(specifier)) {
            violations.push(`${subpath} -> ${file} imports ${specifier}`);
            continue;
          }
          const resolved = resolveRelativeImport(file, specifier);
          if (resolved && !seen.has(resolved)) {
            seen.add(resolved);
            queue.push(resolved);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
