import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { loadPlatformEnvFile, parseEnvFile } from "./env-file.ts";

describe("parseEnvFile", () => {
  test("parses assignments, tolerating export prefixes, quotes, and comments", () => {
    const values = parseEnvFile(
      [
        "# comment",
        "",
        "PLAIN=value",
        "export EXPORTED=yes",
        'DOUBLE="quoted value"',
        "SINGLE='single'",
        "SPACED =  padded  ",
        "URL=postgres://eveland:eveland@localhost/eveland?sslmode=disable",
        "EMPTY=",
      ].join("\n"),
    );
    expect(values).toEqual({
      PLAIN: "value",
      EXPORTED: "yes",
      DOUBLE: "quoted value",
      SINGLE: "single",
      SPACED: "padded",
      URL: "postgres://eveland:eveland@localhost/eveland?sslmode=disable",
      EMPTY: "",
    });
  });

  test("later assignments win, like a shell would resolve them", () => {
    expect(parseEnvFile("A=1\nA=2")).toEqual({ A: "2" });
  });
});

describe("loadPlatformEnvFile", () => {
  test("an appliance's etc/eveland.env wins over the checkout's .env", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-envhome-"));
    const repo = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-envrepo-"));
    await mkdir(path.join(home, "etc"), { recursive: true });
    await writeFile(path.join(home, "etc", "eveland.env"), "SOURCE=appliance", "utf8");
    await writeFile(path.join(repo, ".env"), "SOURCE=checkout", "utf8");
    const loaded = await loadPlatformEnvFile({
      env: { EVELAND_HOME: home },
      repoRoot: repo,
      platform: "linux",
    });
    expect(loaded?.values.SOURCE).toBe("appliance");
    expect(loaded?.path).toBe(path.join(home, "etc", "eveland.env"));
  });

  test("falls back to the checkout's .env, and to null when neither exists", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-envhome-"));
    const repo = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-envrepo-"));
    await writeFile(path.join(repo, ".env"), "SOURCE=checkout", "utf8");
    const loaded = await loadPlatformEnvFile({
      env: { EVELAND_HOME: home },
      repoRoot: repo,
      platform: "linux",
    });
    expect(loaded?.values.SOURCE).toBe("checkout");

    const empty = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-envempty-"));
    expect(
      await loadPlatformEnvFile({
        env: { EVELAND_HOME: home },
        repoRoot: empty,
        platform: "linux",
      }),
    ).toBeNull();
  });
});
