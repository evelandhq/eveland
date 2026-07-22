import { execFile, spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const compatibilityMatrix = [
  { version: "0.25.3", fixtureName: "eve-0.25-schedules", packageName: "eve-0-25" },
  { version: "0.26.2", fixtureName: "eve-0.25-schedules", packageName: "eve-0-26" },
  { version: "0.27.0", fixtureName: "eve-0.25-schedules", packageName: "eve" },
] as const;

describe("Eve schedule compatibility matrix", () => {
  test.each(compatibilityMatrix)("keeps Eve $version runtime state out of the checked-in fixture", async (entry) => {
    const { fixtureDir, sourceFixtureDir } = await prepareFixture(entry);
    try {
      await execFileAsync(process.execPath, [eveBin(entry.packageName), "info", "--json"], { cwd: fixtureDir });

      for (const runtimeDir of [".eve", ".workflow-data", "node_modules"]) {
        await expect(access(path.join(sourceFixtureDir, runtimeDir))).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  test.each(compatibilityMatrix)(
    "Eve $version discovers nested markdown, markdown definitions, and zero/multi-session handlers",
    async (entry) => {
      const { fixtureDir } = await prepareFixture(entry);
      try {
        const { stdout } = await execFileAsync(process.execPath, [eveBin(entry.packageName), "info", "--json"], {
          cwd: fixtureDir,
        });
        const info = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
          artifacts: { compiledManifest: string };
        };
        const manifest = JSON.parse(await readFile(info.artifacts.compiledManifest, "utf8")) as {
          schedules: Array<{ name: string }>;
        };

        expect(manifest.schedules.map((schedule) => schedule.name)).toEqual([
          "billing/sweep",
          "markdown-task",
          "multi-session",
          "zero-session",
        ]);
      } finally {
        await rm(fixtureDir, { recursive: true, force: true });
      }
    },
  );

  test.each(compatibilityMatrix)("Eve $version dev dispatch returns zero or multiple sessions", async (entry) => {
    const { fixtureDir } = await prepareFixture(entry);
    const port = await getFreePort();
    const child = spawn(process.execPath, [eveBin(entry.packageName), "dev", "--no-ui", "--host", "127.0.0.1", "--port", String(port)], {
      cwd: fixtureDir,
      env: process.env,
      stdio: "ignore",
    });

    try {
      await waitForReady(port);

      const zero = await dispatch(port, "zero-session");
      expect(zero).toEqual({ scheduleId: "zero-session", sessionIds: [] });

      const multiple = await dispatch(port, "multi-session");
      expect(multiple.scheduleId).toBe("multi-session");
      expect(multiple.sessionIds).toHaveLength(2);
      expect(new Set(multiple.sessionIds).size).toBe(2);
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
      await rm(fixtureDir, { recursive: true, force: true });
    }
  }, 30_000);
});

function evePackage(packageName: string): string {
  return path.resolve(import.meta.dirname, `../node_modules/${packageName}`);
}

function eveBin(packageName: string): string {
  return path.join(evePackage(packageName), "bin/eve.js");
}

async function prepareFixture(entry: (typeof compatibilityMatrix)[number]): Promise<{
  fixtureDir: string;
  sourceFixtureDir: string;
}> {
  const sourceFixtureDir = path.resolve(import.meta.dirname, `../fixtures/${entry.fixtureName}`);
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "eveland-eve-schedules-"));
  await cp(sourceFixtureDir, fixtureDir, {
    recursive: true,
    filter: (source) => {
      const topLevelEntry = path.relative(sourceFixtureDir, source).split(path.sep)[0] ?? "";
      return ![".eve", ".workflow-data", "node_modules"].includes(topLevelEntry);
    },
  });
  await writeFile(
    path.join(fixtureDir, "package.json"),
    `${JSON.stringify({ name: "eveland-eve-schedules-fixture", private: true, type: "module", dependencies: { eve: entry.version } }, null, 2)}\n`,
  );
  await mkdir(path.join(fixtureDir, "node_modules"));
  await symlink(evePackage(entry.packageName), path.join(fixtureDir, "node_modules/eve"), "dir");
  return { fixtureDir, sourceFixtureDir };
}

async function dispatch(port: number, scheduleId: string): Promise<{ scheduleId: string; sessionIds: string[] }> {
  const response = await fetch(`http://127.0.0.1:${port}/eve/v1/dev/schedules/${scheduleId}`, { method: "POST" });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ scheduleId: string; sessionIds: string[] }>;
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Failed to allocate a fixture port.");
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function waitForReady(port: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/eve/v1/health`);
      if (response.ok) return;
    } catch {
      // The fixture server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the Eve fixture server.");
}
