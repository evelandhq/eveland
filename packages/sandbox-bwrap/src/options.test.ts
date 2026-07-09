import { describe, expect, test } from "vitest";
import { createBwrapOptionsHash, resolveBwrapSandboxOptions } from "./options.js";

describe("resolveBwrapSandboxOptions", () => {
  test("applies defaults", () => {
    expect(resolveBwrapSandboxOptions()).toEqual({
      env: {},
      networkPolicy: "allow-all",
      hidePaths: [],
      bwrapPath: "bwrap",
      cacheDir: null,
    });
  });

  test("keeps explicit values", () => {
    const resolved = resolveBwrapSandboxOptions({
      env: { FOO: "1" },
      networkPolicy: "deny-all",
      hidePaths: ["/srv/private"],
      bwrapPath: "/usr/bin/bwrap",
    });
    expect(resolved.networkPolicy).toBe("deny-all");
    expect(resolved.env).toEqual({ FOO: "1" });
    expect(resolved.hidePaths).toEqual(["/srv/private"]);
    expect(resolved.bwrapPath).toBe("/usr/bin/bwrap");
  });
});

describe("createBwrapOptionsHash", () => {
  test("is stable across env key ordering and distinct for different options", () => {
    const a = createBwrapOptionsHash(resolveBwrapSandboxOptions({ env: { A: "1", B: "2" } }));
    const b = createBwrapOptionsHash(resolveBwrapSandboxOptions({ env: { B: "2", A: "1" } }));
    const c = createBwrapOptionsHash(resolveBwrapSandboxOptions({ env: { A: "1", B: "3" } }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("cacheDir option", () => {
  test("defaults to null and is part of the options hash", () => {
    expect(resolveBwrapSandboxOptions().cacheDir).toBeNull();
    expect(resolveBwrapSandboxOptions({ cacheDir: "/a" }).cacheDir).toBe("/a");
    const a = createBwrapOptionsHash(resolveBwrapSandboxOptions({ cacheDir: "/a" }));
    const b = createBwrapOptionsHash(resolveBwrapSandboxOptions({ cacheDir: "/b" }));
    expect(a).not.toBe(b);
  });
});
