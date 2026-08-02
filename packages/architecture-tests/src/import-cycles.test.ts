import { describe, expect, test } from "vitest";
import {
  importSpecifiers,
  listSourceFiles,
  listWorkspaces,
  readSource,
  resolveImport,
} from "./scan-support.js";

// Known cycles, keyed by their sorted member files. Ratchet: a new cycle
// fails, and breaking a listed cycle forces its removal here.
const CYCLE_ALLOWLIST: string[][] = [];

function findCycleGroups(files: string[]): string[][] {
  const fileSet = new Set(files);
  const edges = new Map<string, string[]>();
  for (const file of files) {
    const targets: string[] = [];
    for (const specifier of importSpecifiers(readSource(file))) {
      // resolveImport also follows @eveland/* subpath (self-)imports, so a
      // cycle routed through the package's own exports map is visible.
      const resolved = resolveImport(file, specifier);
      if (resolved && fileSet.has(resolved)) targets.push(resolved);
    }
    edges.set(file, targets);
  }

  // Tarjan strongly-connected components; a component with more than one
  // member (or a self-loop) is a cycle group.
  let index = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const groups: string[][] = [];

  function connect(node: string): void {
    indices.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of edges.get(node) ?? []) {
      if (!indices.has(target)) {
        connect(target);
        lowLinks.set(node, Math.min(lowLinks.get(node)!, lowLinks.get(target)!));
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indices.get(target)!));
      }
    }
    if (lowLinks.get(node) === indices.get(node)) {
      const component: string[] = [];
      for (;;) {
        const member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
        if (member === node) break;
      }
      const selfLoop = component.length === 1 && (edges.get(node) ?? []).includes(node);
      if (component.length > 1 || selfLoop) groups.push(component.sort());
    }
  }

  for (const file of files) {
    if (!indices.has(file)) connect(file);
  }
  return groups;
}

describe("import cycles", () => {
  test("no import cycles beyond the shrinking allowlist", () => {
    const found: string[][] = [];
    for (const workspace of listWorkspaces()) {
      found.push(...findCycleGroups(listSourceFiles(`${workspace.directory}/src`, { includeTests: true })));
    }
    const foundKeys = found.map((group) => group.join(" <-> ")).sort();
    const allowedKeys = CYCLE_ALLOWLIST.map((group) => [...group].sort().join(" <-> ")).sort();
    expect(foundKeys).toEqual(allowedKeys);
  });
});
