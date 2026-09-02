import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { applianceLayout, readInstallMetadata, repoRoot, resolveApplianceRoot } from "./home.ts";

describe("resolveApplianceRoot", () => {
  test("an explicit EVELAND_HOME wins and is made absolute", () => {
    expect(resolveApplianceRoot({ EVELAND_HOME: "/srv/eveland" }, "linux")).toBe("/srv/eveland");
    expect(path.isAbsolute(resolveApplianceRoot({ EVELAND_HOME: "relative/home" }, "linux"))).toBe(
      true,
    );
  });

  test("platform defaults: ~/.eveland on macOS, /opt/eveland on Linux", () => {
    expect(resolveApplianceRoot({}, "darwin")).toBe(path.join(os.homedir(), ".eveland"));
    expect(resolveApplianceRoot({}, "linux")).toBe("/opt/eveland");
  });

  test("other platforms are refused explicitly", () => {
    expect(() => resolveApplianceRoot({}, "win32")).toThrow(/Unsupported platform/);
  });
});

describe("applianceLayout", () => {
  test("upgrade-replaced and upgrade-surviving trees never overlap", () => {
    const layout = applianceLayout("/opt/eveland");
    expect(layout.sourceDir).toBe("/opt/eveland/source");
    expect(layout.envFilePath).toBe("/opt/eveland/etc/eveland.env");
    expect(layout.installJsonPath).toBe("/opt/eveland/etc/install.json");
    expect(layout.dataDir).toBe("/opt/eveland/data");
    expect(layout.backupsDir).toBe("/opt/eveland/backups");
    // install.json must live in etc/, never data/ — data/ is bind-mounted
    // into containers and would shadow it.
    expect(layout.installJsonPath.startsWith(layout.dataDir)).toBe(false);
  });
});

describe("repoRoot", () => {
  test("resolves to the checkout containing this package", () => {
    expect(repoRoot()).toBe(path.resolve(import.meta.dirname, "../../.."));
  });
});

describe("readInstallMetadata", () => {
  test("missing and malformed files both read as 'not bootstrapped'", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-home-"));
    const layout = applianceLayout(root);
    expect(await readInstallMetadata(layout)).toBeNull();
    await mkdir(layout.etcDir, { recursive: true });
    await writeFile(layout.installJsonPath, "not json", "utf8");
    expect(await readInstallMetadata(layout)).toBeNull();
    await writeFile(layout.installJsonPath, JSON.stringify({ version: 1 }), "utf8");
    expect(await readInstallMetadata(layout)).toBeNull();
  });

  test("a complete metadata file round-trips", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-home-"));
    const layout = applianceLayout(root);
    await mkdir(layout.etcDir, { recursive: true });
    const metadata = {
      version: 1,
      installedAt: "2026-09-01T00:00:00.000Z",
      method: "install.sh",
      osMode: "darwin",
      bootstrapCompleted: true,
    };
    await writeFile(layout.installJsonPath, JSON.stringify(metadata), "utf8");
    expect(await readInstallMetadata(layout)).toEqual(metadata);
  });
});
