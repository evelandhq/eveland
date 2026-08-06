import { builtinModules } from "node:module";
import { describe, expect, test } from "vitest";
import { importSpecifiers, listWorkspaces, readSource, resolveImport } from "./scan-support.js";

// The real builtin list, not a hand-written subset that silently misses
// async_hooks, vm, v8, tty, and friends.
const NODE_BUILTINS = new Set(builtinModules);

function isNodeSpecifier(specifier: string): boolean {
  return specifier.startsWith("node:") || NODE_BUILTINS.has(specifier.split("/")[0]!);
}

describe("browser-safe core exports", () => {
  test("no non-server core export reaches a node builtin or the server subtree", () => {
    const core = listWorkspaces().find((workspace) => workspace.name === "@evelandhq/core")!;
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
          // The walk follows @evelandhq/core subpath self-imports too (the
          // repo's mandated style), so a browser-safe module cannot reach
          // node code through the package's own exports map unseen.
          const resolved = resolveImport(file, specifier);
          if (resolved?.startsWith(`${core.directory}/src/server/`)) {
            violations.push(`${subpath} -> ${file} imports the server subtree via ${specifier}`);
            continue;
          }
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
