import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { EVE_COMPATIBILITY_POLICY } from "@evelandhq/core/eve-compatibility";
import { describe, expect, test } from "vitest";
import { injectSchedulerAdapter } from "./adapter.js";

const execFileAsync = promisify(execFile);
const compatibilityMatrix = EVE_COMPATIBILITY_POLICY.supportedLines.map(
  ({ verifiedVersion, dependencyName }) => ({
    version: verifiedVersion,
    packageName: dependencyName,
  }),
);
describe("injectSchedulerAdapter", () => {
  test("fails closed outside the four verified Eve minors", async () => {
    for (const eveVersion of [
      "0.30.8",
      "0.31.3",
      "0.32.5",
      "0.33.3",
      "0.38.0",
      "~0.38.0",
      ">=0.34.0",
      "*",
      "latest",
    ]) {
      const releaseDir = await fixture({ eveVersion, files: {} });

      await expect(injectSchedulerAdapter({ releaseDir })).rejects.toThrow(
        new RegExp(
          `supports Eve 0\\.34\\.x, 0\\.35\\.x, 0\\.36\\.x, or 0\\.37\\.x.*found ${eveVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        ),
      );
    }
  });

  test("accepts every dependency form that stays inside a verified Eve minor", async () => {
    for (const eveVersion of [
      "0.34.0",
      "0.34.7",
      "~0.34.0",
      "^0.34.0",
      "0.34",
      "0.34.x",
      "0.34.*",
      "0.35.0",
      "0.35.6",
      "~0.35.2",
      "^0.35.0",
      "0.35",
      "0.35.x",
      "0.35.*",
      "0.36.0",
      "0.36.4",
      "~0.36.1",
      "^0.36.0",
      "0.36",
      "0.36.x",
      "0.36.*",
      "0.37.0",
      "~0.37.0",
      "^0.37.0",
      "0.37",
      "0.37.x",
      "0.37.*",
    ]) {
      const releaseDir = await fixture({ eveVersion, files: {} });

      const result = await injectSchedulerAdapter({ releaseDir });

      expect(result.eveVersion).toBe(eveVersion);
    }
  });

  test("rewrites module and Markdown schedules to native no-ops while preserving originals", async () => {
    const releaseDir = await fixture({
      eveVersion: "0.34.5",
      files: {
        "agent/schedules/billing/sweep.ts": `import { defineSchedule } from "eve/schedules";
import { helper } from "../../lib/helper";
export default defineSchedule({ cron: "0 3 * * *", async run() { await helper(); } });
`,
        "agent/schedules/identifier.mjs": `const authored = { cron: "15 4 * * *", async run() {} };
export default authored;
`,
        "agent/schedules/markdown-task.ts": `export default { cron: "20 5 * * *", markdown: "Run the TypeScript markdown task." };
`,
        "agent/schedules/report.md": `---
cron: "30 5 * * *"
---
Produce the daily report.
`,
      },
    });

    const result = await injectSchedulerAdapter({ releaseDir });

    expect(result.definitions.map((definition) => definition.key)).toEqual([
      "billing/sweep",
      "identifier",
      "markdown-task",
      "report",
    ]);
    expect(result.definitions.map((definition) => definition.kind)).toEqual([
      "handler",
      "handler",
      "markdown",
      "markdown",
    ]);
    const transformed = await readFile(
      path.join(releaseDir, "agent/schedules/billing/sweep.ts"),
      "utf8",
    );
    expect(transformed).toContain('from "../../lib/helper"');
    expect(transformed).toContain("__evelandOriginalSchedule");
    expect(transformed).toContain("run: async () => { }");
    expect(transformed).not.toContain(
      'export default defineSchedule({ cron: "0 3 * * *", async run() { await helper(); } })',
    );

    const markdownModule = await readFile(
      path.join(releaseDir, "agent/schedules/report.ts"),
      "utf8",
    );
    expect(markdownModule).toContain(
      'export const __evelandOriginalMarkdown = "Produce the daily report."',
    );
    expect(markdownModule).toContain('cron: "30 5 * * *"');
    await expect(
      readFile(path.join(releaseDir, "agent/schedules/report.md"), "utf8"),
    ).rejects.toThrow(/ENOENT/);
    const channel = await readFile(
      path.join(releaseDir, "agent/channels/eveland-scheduler.ts"),
      "utf8",
    );
    expect(channel).toContain("markdown: schedule2.markdown");
  });

  test("generates a closed authenticated dispatch Channel without embedding secrets", async () => {
    const releaseDir = await fixture({
      eveVersion: "0.34.5",
      files: {
        "agent/schedules/zero.ts": `export default { cron: "* * * * *", async run() {} };`,
      },
    });

    await injectSchedulerAdapter({ releaseDir });
    const channel = await readFile(
      path.join(releaseDir, "agent/channels/eveland-scheduler.ts"),
      "utf8",
    );

    expect(channel).toContain('from "eve/channels"');
    expect(channel).toContain('kindHint: "schedule"');
    expect(channel).toContain('"zero"');
    expect(channel).toContain("EVELAND_SCHEDULER_RUNTIME_SECRET");
    expect(channel).toContain("EVELAND_SCHEDULER_REDEEM_URL");
    expect(channel).toContain("Promise.allSettled");
    expect(channel).toContain(
      "const [runResult] = await Promise.allSettled([entry.definition.run(",
    );
    expect(channel).toContain("const rejected = [runResult, ...settled]");
    expect(channel).toContain("function describeScheduleFailure");
    expect(channel).not.toContain("test-secret");
    expect(channel).not.toContain("eve/dist/src/internal");
    // Every minor in the supported window speaks fixed-session addressing; the
    // continuation-token generation went out of the window with Eve 0.30.
    expect(channel).toContain("{ params, from, to }");
    expect(channel).not.toContain("continuationToken");
  });

  test("generates the fixed-session dispatch Channel", async () => {
    const releaseDir = await fixture({
      eveVersion: "0.34.0",
      files: {
        "agent/schedules/report.md": `---
cron: "30 5 * * *"
---
Produce the daily report.
`,
        "agent/schedules/zero.ts": `export default { cron: "* * * * *", async run() {} };`,
      },
    });

    await injectSchedulerAdapter({ releaseDir });
    const channel = await readFile(
      path.join(releaseDir, "agent/channels/eveland-scheduler.ts"),
      "utf8",
    );

    expect(channel).toContain("{ params, from, to }");
    expect(channel).toContain("await from(`eveland-schedule:${params.scheduleRunId}`).send(");
    expect(channel).toContain("to: wrappedTo");
    expect(channel).toContain(
      "const [runResult] = await Promise.allSettled([entry.definition.run(",
    );
    expect(channel).not.toContain("continuationToken");
    expect(channel).not.toContain("receive");
  });

  test("asks for the queued turn policy on every supported Eve line", async () => {
    // Eve 0.33 made "steer" the default send policy, which cancels a turn
    // already running on the target session. A schedule is a background actor
    // and must never preempt a turn a human is waiting on. Every line in the
    // current 0.34-0.37 window supports the explicit `turnPolicy` option.
    const files = {
      "agent/schedules/zero.ts": `export default { cron: "* * * * *", async run() {} };`,
    };
    const readChannel = async (eveVersion: string) => {
      const releaseDir = await fixture({ eveVersion, files });
      await injectSchedulerAdapter({ releaseDir });
      return readFile(path.join(releaseDir, "agent/channels/eveland-scheduler.ts"), "utf8");
    };

    for (const { version: eveVersion } of compatibilityMatrix) {
      expect(await readChannel(eveVersion), eveVersion).toContain("turnPolicy");
    }

    const current = await readChannel(
      EVE_COMPATIBILITY_POLICY.supportedLines.at(-1)!.verifiedVersion,
    );
    // Both send sites: the markdown dispatch and the wrapper around the
    // authored handler's own `to(...).send`, where the author still wins
    // because their options are spread last.
    expect(current).toContain('turnPolicy: "queue",\n            mode: "task"');
    expect(current).toContain('handle.send(message, { turnPolicy: "queue", ...options })');
  });

  test.each(["ts", "mts", "cts", "js", "mjs", "cjs"])(
    "transforms an authored .%s module schedule with the TypeScript AST",
    async (extension) => {
      const sourcePath = `agent/schedules/nested/direct.${extension}`;
      const releaseDir = await fixture({
        eveVersion: "0.34.5",
        files: { [sourcePath]: `export default { cron: "0 6 * * *", async run() {} };` },
      });

      const result = await injectSchedulerAdapter({ releaseDir });

      expect(result.definitions).toEqual([
        expect.objectContaining({ key: "nested/direct", kind: "handler", sourcePath }),
      ]);
      await expect(readFile(path.join(releaseDir, sourcePath), "utf8")).resolves.toContain(
        "__evelandOriginalSchedule",
      );
    },
  );

  test("rejects reserved authored identifiers and the reserved Channel path", async () => {
    const identifierCollision = await fixture({
      eveVersion: "0.34.5",
      files: {
        "agent/schedules/collision.ts": `const __evelandOriginalSchedule = {}; export default __evelandOriginalSchedule;`,
      },
    });
    await expect(injectSchedulerAdapter({ releaseDir: identifierCollision })).rejects.toThrow(
      /reserved identifier/,
    );

    const channelCollision = await fixture({
      eveVersion: "0.34.5",
      files: {
        "agent/schedules/ok.ts": `export default { cron: "* * * * *", async run() {} };`,
        "agent/channels/eveland-scheduler.ts": `export default {};`,
      },
    });
    await expect(injectSchedulerAdapter({ releaseDir: channelCollision })).rejects.toThrow(
      /reserved Channel/,
    );

    const defaultReExport = await fixture({
      eveVersion: "0.34.5",
      files: {
        "agent/lib/shared.ts": `export default { cron: "0 7 * * *", async run() {} };`,
        "agent/schedules/re-export.ts": `export { default } from "../lib/shared";`,
      },
    });
    await expect(injectSchedulerAdapter({ releaseDir: defaultReExport })).rejects.toThrow(
      /concrete default export.*default re-exports are not supported/,
    );
  });

  test.each(compatibilityMatrix)(
    "builds the transformed overlay with the real Eve $version compiler",
    async ({ packageName, version }) => {
      const releaseDir = await fixture({
        eveVersion: version,
        evePackageName: packageName,
        files: {
          "agent/schedules/nested/markdown.md": `---
cron: "0 3 * * *"
---
Run the nested task.
`,
          "agent/schedules/zero.ts": `import { defineSchedule } from "eve/schedules";
export default defineSchedule({ cron: "15 4 * * *", async run({ waitUntil }) { waitUntil(Promise.resolve()); } });
`,
        },
      });
      await injectSchedulerAdapter({ releaseDir });

      const compilerBin = eveBinFor(packageName);
      const { stdout } = await execFileAsync(process.execPath, [compilerBin, "info", "--json"], {
        cwd: releaseDir,
      });
      const info = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
        diagnostics: { errors: number };
      };
      expect(info.diagnostics.errors).toBe(0);
      await expect(
        execFileAsync(process.execPath, [compilerBin, "build", "--skip-sandbox-prewarm"], {
          cwd: releaseDir,
        }),
      ).resolves.toMatchObject({
        stderr: expect.not.stringContaining("error"),
      });
    },
    60_000,
  );

  test.each(compatibilityMatrix)(
    "executes the authenticated scheduler channel on Eve $version",
    async ({ packageName, version }) => {
      const releaseDir = await fixture({
        eveVersion: version,
        evePackageName: packageName,
        files: {
          "agent/schedules/zero.ts": `export default { cron: "* * * * *", async run({ waitUntil }) { waitUntil(Promise.resolve()); } };`,
          "agent/schedules/broken.ts": `export default { cron: "* * * * *", async run() { throw new Error("fixture handler exploded"); } };`,
        },
      });
      await injectSchedulerAdapter({ releaseDir });
      const compilerBin = eveBinFor(packageName);
      await execFileAsync(process.execPath, [compilerBin, "build", "--skip-sandbox-prewarm"], {
        cwd: releaseDir,
      });
      const runtimePort = await availablePort();
      const reports: unknown[] = [];
      const claimedCredentials = new Set<string>();
      const redeemServer = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const report = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          phase?: string;
          credential?: string;
        };
        reports.push(report);
        if (
          report.phase === "claim" &&
          report.credential &&
          claimedCredentials.has(report.credential)
        ) {
          response.writeHead(409, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false }));
          return;
        }
        if (report.phase === "claim" && report.credential)
          claimedCredentials.add(report.credential);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
      await new Promise<void>((resolve) => redeemServer.listen(0, "127.0.0.1", resolve));
      const redeemAddress = redeemServer.address();
      if (!redeemAddress || typeof redeemAddress === "string")
        throw new Error("Expected redeem server port.");
      const child = spawn(
        process.execPath,
        [compilerBin, "start", "--host", "127.0.0.1", "--port", String(runtimePort)],
        {
          cwd: releaseDir,
          env: {
            ...process.env,
            EVELAND_SCHEDULER_RUNTIME_SECRET: "runtime-fixture-secret",
            EVELAND_SCHEDULER_REDEEM_URL: `http://127.0.0.1:${redeemAddress.port}/internal/scheduler/dispatch`,
          },
          stdio: "ignore",
        },
      );

      try {
        await waitUntilReachable(`http://127.0.0.1:${runtimePort}/health`);
        const unauthenticated = await fetch(
          `http://127.0.0.1:${runtimePort}/eveland/scheduler/srun_fixture`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ scheduleKey: "zero" }),
          },
        );
        expect(unauthenticated.status).toBe(401);

        const unknown = await fetch(
          `http://127.0.0.1:${runtimePort}/eveland/scheduler/srun_fixture`,
          {
            method: "POST",
            headers: {
              authorization: "Bearer unknown-fixture",
              "content-type": "application/json",
              "x-eveland-runtime-secret": "runtime-fixture-secret",
            },
            body: JSON.stringify({ scheduleKey: "missing" }),
          },
        );
        expect(unknown.status).toBe(404);

        const response = await fetch(
          `http://127.0.0.1:${runtimePort}/eveland/scheduler/srun_fixture`,
          {
            method: "POST",
            headers: {
              authorization: "Bearer dispatch-fixture",
              "content-type": "application/json",
              "x-eveland-runtime-secret": "runtime-fixture-secret",
            },
            body: JSON.stringify({ scheduleKey: "zero" }),
          },
        );
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
          scheduleRunId: "srun_fixture",
          scheduleKey: "zero",
          sessionIds: [],
        });

        const replay = await fetch(
          `http://127.0.0.1:${runtimePort}/eveland/scheduler/srun_fixture`,
          {
            method: "POST",
            headers: {
              authorization: "Bearer dispatch-fixture",
              "content-type": "application/json",
              "x-eveland-runtime-secret": "runtime-fixture-secret",
            },
            body: JSON.stringify({ scheduleKey: "zero" }),
          },
        );
        expect(replay.status).toBe(409);
        expect(reports).toEqual([
          expect.objectContaining({
            phase: "claim",
            credential: "dispatch-fixture",
            scheduleRunId: "srun_fixture",
          }),
          expect.objectContaining({
            phase: "complete",
            credential: "dispatch-fixture",
            status: "succeeded",
            sessionIds: [],
          }),
          expect.objectContaining({
            phase: "claim",
            credential: "dispatch-fixture",
            scheduleRunId: "srun_fixture",
          }),
        ]);

        const failing = await fetch(
          `http://127.0.0.1:${runtimePort}/eveland/scheduler/srun_broken`,
          {
            method: "POST",
            headers: {
              authorization: "Bearer dispatch-broken",
              "content-type": "application/json",
              "x-eveland-runtime-secret": "runtime-fixture-secret",
            },
            body: JSON.stringify({ scheduleKey: "broken" }),
          },
        );
        expect(failing.status).toBe(500);
        expect(reports.slice(3)).toEqual([
          expect.objectContaining({
            phase: "claim",
            credential: "dispatch-broken",
            scheduleRunId: "srun_broken",
          }),
          expect.objectContaining({
            phase: "complete",
            credential: "dispatch-broken",
            status: "failed",
            sessionIds: [],
            error: expect.stringContaining("fixture handler exploded"),
          }),
        ]);
      } finally {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => redeemServer.close(() => resolve()));
      }
    },
    60_000,
  );
});

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected available TCP port.");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitUntilReachable(url: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // The production server has not bound yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

function eveBinFor(packageName: string): string {
  return path.resolve(import.meta.dirname, `../node_modules/${packageName}/bin/eve.js`);
}

async function fixture(input: {
  eveVersion: string;
  evePackageName?: string;
  files: Record<string, string>;
}): Promise<string> {
  const releaseDir = await mkdtemp(path.join(os.tmpdir(), "eveland-scheduler-"));
  await writeFile(
    path.join(releaseDir, "package.json"),
    JSON.stringify({ name: "scheduler-fixture", dependencies: { eve: input.eveVersion } }),
  );
  await mkdir(path.join(releaseDir, "node_modules"));
  await symlink(
    path.resolve(import.meta.dirname, `../node_modules/${input.evePackageName ?? "eve"}`),
    path.join(releaseDir, "node_modules/eve"),
  );
  await mkdir(path.join(releaseDir, "agent"), { recursive: true });
  await writeFile(path.join(releaseDir, "agent/instructions.md"), "Fixture.");
  for (const [relativePath, content] of Object.entries(input.files)) {
    const target = path.join(releaseDir, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return releaseDir;
}
