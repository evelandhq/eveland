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
  { version: "0.27.8", fixtureName: "eve-0.25-schedules", packageName: "eve" },
] as const;

// Every test here copies a fixture, symlinks a real Eve release into it, and
// shells out to that Eve to compile the project. Vitest's 5s default is a
// build budget, not a test budget: it passes on an idle machine and times out
// when the whole repository suite runs in parallel, so each test states its
// own.
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
  }, 120_000);

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
    120_000,
  );

  test.each(compatibilityMatrix)("Eve $version dev dispatch returns zero or multiple sessions", async (entry) => {
    const { fixtureDir } = await prepareFixture(entry);
    const port = await getFreePort();
    const child = spawn(process.execPath, [eveBin(entry.packageName), "dev", "--no-ui", "--host", "127.0.0.1", "--port", String(port)], {
      cwd: fixtureDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Captured so a readiness timeout reports what the dev server actually
    // said instead of leaving a bare failure to reproduce by hand.
    let output = "";
    const capture = (chunk: unknown) => {
      output = `${output}${String(chunk)}`.slice(-4_000);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    try {
      await waitForReady(port, () => output);

      const zero = await dispatch(port, "zero-session", () => output);
      expect(zero).toEqual({ scheduleId: "zero-session", sessionIds: [] });

      const multiple = await dispatch(port, "multi-session", () => output);
      expect(multiple.scheduleId).toBe("multi-session");
      expect(multiple.sessionIds).toHaveLength(2);
      expect(new Set(multiple.sessionIds).size).toBe(2);
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
      await rm(fixtureDir, { recursive: true, force: true });
    }
  }, 120_000);
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

/**
 * Dispatches a fixture schedule, tolerating the dev server's startup window.
 *
 * What this test asserts is the zero/multi-session payload semantics, not that
 * the very first request after boot succeeds. A 500 immediately after startup
 * is a readiness artifact -- retried briefly here so it cannot make the suite
 * flaky -- while a real regression fails every attempt and still surfaces,
 * with the server's own output attached.
 */
async function dispatch(
  port: number,
  scheduleId: string,
  serverOutput: () => string = () => "",
): Promise<{ scheduleId: string; sessionIds: string[] }> {
  const deadline = Date.now() + 20_000;
  let lastStatus = 0;
  let lastBody = "";
  for (;;) {
    const response = await fetch(`http://127.0.0.1:${port}/eve/v1/dev/schedules/${scheduleId}`, { method: "POST" });
    if (response.ok) {
      return response.json() as Promise<{ scheduleId: string; sessionIds: string[] }>;
    }
    lastStatus = response.status;
    lastBody = await response.text().catch(() => "");
    if (response.status < 500 || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `Dispatching ${scheduleId} kept failing with ${lastStatus}: ${lastBody}\n` +
      `Server output:\n${serverOutput() || "(none captured)"}`,
  );
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

/**
 * Waits for the dev runtime to have compiled a snapshot, not merely for the
 * HTTP server to bind.
 *
 * `/eve/v1/health` answers as soon as the port is listening, which is before
 * schedules are compiled and registered -- dispatching in that window returns
 * 500, which is what made this test flaky on CI while passing locally, where
 * compilation finishes sooner. `/eve/v1/dev/runtime-artifacts` reports the
 * compiled snapshot revision and so is the signal the dispatch below actually
 * depends on. It exists in every version of the compatibility matrix.
 */
async function waitForReady(port: number, serverOutput: () => string): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastDetail = "no response yet";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/eve/v1/dev/runtime-artifacts`);
      if (response.ok) {
        const artifacts = (await response.json()) as { revision?: unknown };
        if (typeof artifacts.revision === "string" && artifacts.revision.length > 0) return;
        lastDetail = `runtime artifacts reported no revision: ${JSON.stringify(artifacts)}`;
      } else {
        lastDetail = `runtime artifacts responded ${response.status}`;
      }
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for the Eve fixture server to compile a runtime snapshot. ` +
      `Last probe: ${lastDetail}\nServer output:\n${serverOutput() || "(none captured)"}`,
  );
}
