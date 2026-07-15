import { execFile, spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const sourceFixtureDir = path.resolve(import.meta.dirname, "../fixtures/eve-0.24-schedules");
const eveBin = path.resolve(import.meta.dirname, "../node_modules/.bin/eve");
const evePackageDir = path.resolve(import.meta.dirname, "../node_modules/eve");
let fixtureDir = "";

beforeEach(async () => {
  fixtureDir = await mkdtemp(path.join(os.tmpdir(), "eveland-eve-schedules-"));
  await cp(sourceFixtureDir, fixtureDir, {
    recursive: true,
    filter: (source) => {
      const topLevelEntry = path.relative(sourceFixtureDir, source).split(path.sep)[0] ?? "";
      return ![".eve", ".workflow-data", "node_modules"].includes(topLevelEntry);
    },
  });
  await mkdir(path.join(fixtureDir, "node_modules"));
  await symlink(evePackageDir, path.join(fixtureDir, "node_modules/eve"), "dir");
});

afterEach(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

describe("Eve 0.24.x schedule behavior", () => {
  test("keeps Eve runtime state out of the checked-in fixture", async () => {
    await execFileAsync(eveBin, ["info", "--json"], { cwd: fixtureDir });

    for (const runtimeDir of [".eve", ".workflow-data", "node_modules"]) {
      await expect(access(path.join(sourceFixtureDir, runtimeDir))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  test("discovers nested markdown, markdown definitions, and zero/multi-session handlers", async () => {
    const { stdout } = await execFileAsync(eveBin, ["info", "--json"], { cwd: fixtureDir });
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
  });

  test("the public dev dispatch contract returns zero or multiple Eve sessions", async () => {
    const port = await getFreePort();
    const child = spawn(eveBin, ["dev", "--no-ui", "--host", "127.0.0.1", "--port", String(port)], {
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
    }
  }, 30_000);
});

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
