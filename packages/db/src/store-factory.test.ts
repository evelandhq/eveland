import { afterEach, describe, expect, test } from "vitest";
import { createStoreFromEnv } from "./store-factory.js";

describe("createStoreFromEnv", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  afterEach(() => {
    restoreEnv("DATABASE_URL", originalDatabaseUrl);
  });

  test("throws a clear error when DATABASE_URL is missing", () => {
    delete process.env.DATABASE_URL;

    expect(() => createStoreFromEnv()).toThrow(/DATABASE_URL/);
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
