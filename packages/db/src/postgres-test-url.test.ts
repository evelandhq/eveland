import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { resolvePostgresTestUrl } from "./postgres-integration.test-support.js";

const dir = mkdtempSync(path.join(tmpdir(), "eveland-test-url-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const missing = path.join(dir, "does-not-exist.env");

describe("resolvePostgresTestUrl", () => {
  test("the environment variable wins over .env.local", () => {
    const envLocalPath = path.join(dir, "env-wins.local");
    writeFileSync(envLocalPath, "EVELAND_POSTGRES_TEST_URL=postgres://file/db\n");
    const url = resolvePostgresTestUrl({
      env: { EVELAND_POSTGRES_TEST_URL: "postgres://env/db" },
      envLocalPath,
      devDatabaseUrl: null,
    });
    expect(url).toBe("postgres://env/db");
  });

  test("falls back to .env.local, tolerating export prefix and quotes", () => {
    const envLocalPath = path.join(dir, "fallback.local");
    writeFileSync(
      envLocalPath,
      '# comment\nOTHER=1\nexport EVELAND_POSTGRES_TEST_URL="postgres://file/db"\n',
    );
    const url = resolvePostgresTestUrl({ env: {}, envLocalPath, devDatabaseUrl: null });
    expect(url).toBe("postgres://file/db");
  });

  test("returns undefined when neither source has a value", () => {
    expect(resolvePostgresTestUrl({ env: {}, envLocalPath: missing, devDatabaseUrl: null })).toBe(
      undefined,
    );
  });

  test("refuses to run against the dev database", () => {
    expect(() =>
      resolvePostgresTestUrl({
        env: { EVELAND_POSTGRES_TEST_URL: "postgres://dev/db" },
        envLocalPath: missing,
        devDatabaseUrl: "postgres://dev/db",
      }),
    ).toThrow(/dev database/);
  });

  test("a distinct dedicated database passes the dev-database guard", () => {
    const url = resolvePostgresTestUrl({
      env: { EVELAND_POSTGRES_TEST_URL: "postgres://host/eveland_test" },
      envLocalPath: missing,
      devDatabaseUrl: "postgres://host/eveland",
    });
    expect(url).toBe("postgres://host/eveland_test");
  });
});
