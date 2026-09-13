import { describe, expect, test } from "vitest";
import { pnpmSharedStoreArgs, resolvePnpmSharedStore } from "./package-manager.js";

describe("resolvePnpmSharedStore", () => {
  test("keeps both pnpm directories inside the shared npm cache", () => {
    expect(resolvePnpmSharedStore("/var/lib/eveland-data/npm-cache")).toEqual({
      storeDir: "/var/lib/eveland-data/npm-cache/_pnpm-store",
      cacheDir: "/var/lib/eveland-data/npm-cache/_pnpm-cache",
    });
  });
});

describe("pnpmSharedStoreArgs", () => {
  test("is empty without a shared store", () => {
    expect(pnpmSharedStoreArgs(undefined)).toBe("");
  });

  test("points pnpm at the store and cache and never hardlinks out of the store", () => {
    expect(pnpmSharedStoreArgs(resolvePnpmSharedStore("/data/npm-cache"))).toBe(
      " --config.store-dir='/data/npm-cache/_pnpm-store'" +
        " --config.cache-dir='/data/npm-cache/_pnpm-cache'" +
        " --config.package-import-method=clone-or-copy",
    );
  });

  test("shell-quotes the directories", () => {
    expect(pnpmSharedStoreArgs({ storeDir: "/it's/store", cacheDir: "/a b/cache" })).toContain(
      `--config.store-dir='/it'"'"'s/store' --config.cache-dir='/a b/cache'`,
    );
  });
});
