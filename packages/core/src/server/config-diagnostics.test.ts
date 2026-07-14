import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createConfigurationSnapshot } from "../config-diagnostics.js";
import { readConfigurationSnapshotFile, writeConfigurationSnapshotFile } from "./config-diagnostics.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("configuration snapshot files", () => {
  test("atomically persists a sanitized Worker snapshot with private permissions", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "eveland-config-"));
    tempDirectories.push(dataDir);
    const snapshot = createConfigurationSnapshot(
      "worker",
      { APP_SECRET_KEY: "never-write-this-value" },
      new Date("2026-07-15T00:00:00.000Z"),
    );

    const snapshotPath = await writeConfigurationSnapshotFile(dataDir, snapshot);

    expect(snapshotPath).toBe(path.join(dataDir, "diagnostics", "worker-configuration.json"));
    expect(await readConfigurationSnapshotFile(dataDir, "worker")).toEqual(snapshot);
    expect(await readFile(snapshotPath, "utf8")).not.toContain("never-write-this-value");
    expect((await stat(snapshotPath)).mode & 0o777).toBe(0o600);
  });
});
