import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { normalizeOrigin, resolveOrigin } from "./origin.ts";

describe("origin resolution", () => {
  test("an explicit --origin wins and is normalized", async () => {
    await expect(resolveOrigin("https://Eveland.Example.com/", {})).resolves.toBe(
      "https://eveland.example.com",
    );
  });

  test("rejects non-origin values", () => {
    expect(() => normalizeOrigin("not a url")).toThrow(/Invalid origin/);
    expect(() => normalizeOrigin("ftp://example.com")).toThrow(/http\(s\)/);
    expect(() => normalizeOrigin("http://example.com/dashboard")).toThrow(/no path/);
  });

  test("falls back to the local install's EVELAND_PUBLIC_ORIGIN", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "eveland-home-"));
    await mkdir(path.join(home, "etc"), { recursive: true });
    await writeFile(
      path.join(home, "etc", "eveland.env"),
      'NODE_ENV=production\nEVELAND_PUBLIC_ORIGIN="http://eveland.internal:17300"\n',
    );
    await expect(resolveOrigin(undefined, { EVELAND_HOME: home })).resolves.toBe(
      "http://eveland.internal:17300",
    );
  });

  test("demands --origin when there is no local install", async () => {
    await expect(resolveOrigin(undefined, {})).rejects.toThrow(/--origin/);
  });
});
