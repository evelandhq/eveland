import { afterEach, describe, expect, test } from "vitest";
import { createStoreFromEnv } from "./store-factory.js";

describe("createStoreFromEnv", () => {
  const original = {
    STORE_DRIVER: process.env.STORE_DRIVER,
    DATABASE_URL: process.env.DATABASE_URL,
  };

  afterEach(() => {
    restoreEnv("STORE_DRIVER", original.STORE_DRIVER);
    restoreEnv("DATABASE_URL", original.DATABASE_URL);
  });

  test("uses an in-memory store when STORE_DRIVER=memory", async () => {
    process.env.STORE_DRIVER = "memory";
    delete process.env.DATABASE_URL;

    const factory = createStoreFromEnv();
    await expect(factory.store.listProjects()).resolves.toEqual([]);
    await factory.close();
  });

  test("throws a clear error when DATABASE_URL is missing and STORE_DRIVER is not memory", () => {
    delete process.env.STORE_DRIVER;
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
