import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  isWithinWorkspace,
  isWithinWorkspaceReal,
  resolveBwrapCacheRoot,
  resolveSessionPath,
  resolveTemplatePath,
  resolveWorkspacePath,
  toHostPath,
  WORKSPACE_ROOT,
} from "./paths.js";

describe("cache layout", () => {
  test("nests under eve's local sandbox cache convention", () => {
    expect(resolveBwrapCacheRoot("/app")).toBe("/app/.eve/sandbox-cache/bwrap");
  });

  test("template paths are hash-keyed and options-scoped", () => {
    const a = resolveTemplatePath("/app", "tpl-key", "aaaa");
    const b = resolveTemplatePath("/app", "tpl-key", "bbbb");
    const c = resolveTemplatePath("/app", "other-key", "aaaa");
    expect(a).toMatch(/^\/app\/\.eve\/sandbox-cache\/bwrap\/templates\/[0-9a-f]{32}-aaaa$/);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  test("session paths are keyed by session key only", () => {
    expect(resolveSessionPath("/app", "sess/with:odd chars")).toMatch(
      /^\/app\/\.eve\/sandbox-cache\/bwrap\/sessions\/[0-9a-f]{32}$/,
    );
  });
});

describe("workspace paths", () => {
  test("anchors relative paths to /workspace and passes absolute through", () => {
    expect(resolveWorkspacePath("notes/a.txt")).toBe("/workspace/notes/a.txt");
    expect(resolveWorkspacePath("/etc/hosts")).toBe("/etc/hosts");
    expect(WORKSPACE_ROOT).toBe("/workspace");
  });

  test("translates workspace paths to host paths", () => {
    expect(toHostPath("notes/a.txt", "/data/sess1")).toBe("/data/sess1/notes/a.txt");
    expect(toHostPath("/workspace", "/data/sess1")).toBe("/data/sess1");
    expect(toHostPath("/workspace/x", "/data/sess1")).toBe("/data/sess1/x");
    expect(toHostPath("/etc/hosts", "/data/sess1")).toBe("/etc/hosts");
  });

  test("containment check rejects escapes", () => {
    expect(isWithinWorkspace("/data/sess1/notes", "/data/sess1")).toBe(true);
    expect(isWithinWorkspace("/data/sess1", "/data/sess1")).toBe(true);
    expect(isWithinWorkspace("/data/other", "/data/sess1")).toBe(false);
    // traversal normalizes out of the workspace
    expect(isWithinWorkspace(toHostPath("a/../../escape", "/data/sess1"), "/data/sess1")).toBe(false);
  });
});

describe("isWithinWorkspaceReal", () => {
  test("symlink escaping the workspace is rejected; inside-workspace symlink is allowed", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bwrap-real-"));
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, path.join(workspace, "escape"));
    symlinkSync(path.join(workspace, "inner-target"), path.join(workspace, "inner-link"));
    mkdirSync(path.join(workspace, "inner-target"), { recursive: true });

    expect(isWithinWorkspaceReal(path.join(workspace, "escape", "victim.txt"), workspace)).toBe(false);
    expect(isWithinWorkspaceReal(path.join(workspace, "inner-link", "ok.txt"), workspace)).toBe(true);
    expect(isWithinWorkspaceReal(path.join(workspace, "new-dir", "new-file.txt"), workspace)).toBe(true);
  });

  test("dangling symlink is rejected", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bwrap-real-"));
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    symlinkSync(path.join(root, "nowhere"), path.join(workspace, "dangling"));
    expect(isWithinWorkspaceReal(path.join(workspace, "dangling"), workspace)).toBe(false);
  });
});
