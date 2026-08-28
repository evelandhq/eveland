import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { injectObserverHooks } from "@evelandhq/agent-observer";
import { injectSchedulerAdapter, readSchedulerDefinitions } from "@evelandhq/agent-scheduler";
import { afterEach, expect, test } from "vitest";
import { injectExtensionIntegrator } from "./extension-integration.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const evePackageRoot = path.resolve(
  import.meta.dirname,
  "../../../../packages/agent-scheduler/node_modules/eve",
);
const eveBin = path.join(evePackageRoot, "bin/eve.js");
const oldestEvePackageRoot = path.resolve(
  import.meta.dirname,
  "../../../../packages/agent-scheduler/node_modules/eve-oldest",
);
const oldestEveBin = path.join(oldestEvePackageRoot, "bin/eve.js");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("builds Extension schedules and observed Extension subagents with the real Eve 0.44 compiler", async () => {
  const releaseDir = await mkdtemp(path.join(os.tmpdir(), "eveland-extension-release-"));
  roots.push(releaseDir);
  const extensionPackageRoot = path.join(releaseDir, "packages/crm");
  await writeFixtureExtension(extensionPackageRoot);
  await execFileAsync(process.execPath, [eveBin, "extension", "build"], {
    cwd: extensionPackageRoot,
  });
  await writeConsumer(releaseDir, extensionPackageRoot);

  await injectObserverHooks({ releaseDir });
  await injectSchedulerAdapter({ releaseDir });
  const integratorPath = await injectExtensionIntegrator(releaseDir);
  await execFileAsync(process.execPath, [eveBin, "info", "--json"], { cwd: releaseDir });
  const integration = await execFileAsync(process.execPath, [integratorPath], {
    cwd: releaseDir,
  });

  expect(integration.stdout).toContain("[eveland-extensions]");
  expect(integration.stdout).toContain('"observerCoverageGaps":[');
  expect(integration.stdout).toContain('"scheduleDefinitions":2');
  await expect(
    readFile(
      path.join(releaseDir, ".eveland/observability/extension-coverage-gaps.json"),
      "utf8",
    ).then((value) => JSON.parse(value)),
  ).resolves.toEqual([
    {
      kind: "file-form-subagent",
      path: "node_modules/@fixture/crm/dist/extension/subagents/quick.mjs",
      reason: expect.stringContaining("no independent hooks slot"),
    },
  ]);
  await expect(readSchedulerDefinitions(releaseDir)).resolves.toEqual([
    expect.objectContaining({
      key: "crm__digest",
      kind: "markdown",
      cron: "30 2 * * *",
      sourcePath: "agent/extensions/crm/schedules/digest.md",
    }),
    expect.objectContaining({
      key: "crm__sync",
      kind: "handler",
      cron: "0 2 * * *",
      sourcePath: "agent/extensions/crm/schedules/sync.mjs",
    }),
  ]);
  await expect(
    readFile(path.join(extensionPackageRoot, "dist/extension/schedules/sync.mjs"), "utf8"),
  ).resolves.toContain("__evelandOriginalSchedule");
  await expect(
    readFile(
      path.join(
        extensionPackageRoot,
        "dist/extension/subagents/reviewer/hooks/eveland-observer.js",
      ),
      "utf8",
    ),
  ).resolves.toContain("eveland-observer-runtime.mjs");

  await execFileAsync(process.execPath, [eveBin, "build", "--skip-sandbox-prewarm"], {
    cwd: releaseDir,
  });
  await execFileAsync(process.execPath, [eveBin, "info", "--json"], { cwd: releaseDir });
  const finalManifest = JSON.parse(
    await readFile(path.join(releaseDir, ".eve/discovery/agent-discovery-manifest.json"), "utf8"),
  ) as {
    resolvedExtensions: Array<{
      manifest: {
        subagents: Array<{
          subagentId: string;
          manifest: { hooks: Array<{ logicalPath: string }> };
        }>;
      };
    }>;
  };
  expect(
    finalManifest.resolvedExtensions[0]?.manifest.subagents
      .find((subagent) => subagent.subagentId === "reviewer")
      ?.manifest.hooks.map((hook) => hook.logicalPath),
  ).toContain("hooks/eveland-observer.js");

  const runtimePort = await availablePort();
  const reports: Array<{ phase?: string }> = [];
  const redeemServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    reports.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as { phase?: string });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => redeemServer.listen(0, "127.0.0.1", resolve));
  const redeemAddress = redeemServer.address();
  if (!redeemAddress || typeof redeemAddress === "string") {
    throw new Error("Expected the Extension schedule redeem server to bind a port.");
  }
  const child = spawn(
    process.execPath,
    [eveBin, "start", "--host", "127.0.0.1", "--port", String(runtimePort)],
    {
      cwd: releaseDir,
      env: {
        ...process.env,
        EVELAND_SCHEDULER_RUNTIME_SECRET: "extension-runtime-secret",
        EVELAND_SCHEDULER_REDEEM_URL: `http://127.0.0.1:${redeemAddress.port}/internal/scheduler/dispatch`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let childOutput = "";
  child.stdout.on("data", (chunk) => {
    childOutput += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    childOutput += String(chunk);
  });
  try {
    await waitUntilReachable(`http://127.0.0.1:${runtimePort}/health`).catch((error) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${childOutput}`);
    });
    const dispatch = await fetch(
      `http://127.0.0.1:${runtimePort}/eveland/scheduler/srun_extension`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer extension-dispatch",
          "content-type": "application/json",
          "x-eveland-runtime-secret": "extension-runtime-secret",
        },
        body: JSON.stringify({ scheduleKey: "crm__sync" }),
      },
    );
    expect(dispatch.status).toBe(200);
    await expect(dispatch.json()).resolves.toMatchObject({
      scheduleRunId: "srun_extension",
      scheduleKey: "crm__sync",
      sessionIds: [],
    });
    expect(reports.map((report) => report.phase)).toEqual(["claim", "complete"]);
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => redeemServer.close(() => resolve()));
  }
}, 120_000);

test("keeps the Extension integrator compatible with the oldest supported Eve 0.44 manifest", async () => {
  const releaseDir = await mkdtemp(path.join(os.tmpdir(), "eveland-extension-oldest-"));
  roots.push(releaseDir);
  const extensionPackageRoot = path.join(releaseDir, "packages/crm");
  await writeFixtureExtension(extensionPackageRoot, oldestEvePackageRoot, "0.45.2", false);
  await execFileAsync(process.execPath, [oldestEveBin, "extension", "build"], {
    cwd: extensionPackageRoot,
  });
  await writeConsumer(releaseDir, extensionPackageRoot, oldestEvePackageRoot, "0.45.2");

  await injectObserverHooks({ releaseDir });
  await injectSchedulerAdapter({ releaseDir });
  const integratorPath = await injectExtensionIntegrator(releaseDir);
  await execFileAsync(process.execPath, [oldestEveBin, "info", "--json"], { cwd: releaseDir });
  await execFileAsync(process.execPath, [integratorPath], { cwd: releaseDir });
  await execFileAsync(process.execPath, [oldestEveBin, "build", "--skip-sandbox-prewarm"], {
    cwd: releaseDir,
  });
  await execFileAsync(process.execPath, [oldestEveBin, "info", "--json"], { cwd: releaseDir });

  await expect(readSchedulerDefinitions(releaseDir)).resolves.toEqual([]);
  await expect(
    readFile(
      path.join(releaseDir, ".eveland/observability/extension-coverage-gaps.json"),
      "utf8",
    ).then((value) => JSON.parse(value)),
  ).resolves.toEqual([]);
}, 120_000);

async function writeFixtureExtension(
  extensionPackageRoot: string,
  installedEveRoot = evePackageRoot,
  eveVersion = "0.45.2",
  includeScheduleSubagents = true,
): Promise<void> {
  await write(
    extensionPackageRoot,
    "package.json",
    JSON.stringify({
      name: "@fixture/crm",
      version: "0.0.0",
      type: "module",
      eve: { extension: { source: "./extension", dist: "./dist/extension" } },
      files: ["dist"],
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.mjs" },
      },
      peerDependencies: { eve: "*" },
      devDependencies: { eve: eveVersion },
    }),
  );
  await write(
    extensionPackageRoot,
    "extension/extension.ts",
    'import { defineExtension } from "eve/extension";\nexport default defineExtension();\n',
  );
  if (includeScheduleSubagents) {
    await write(
      extensionPackageRoot,
      "extension/schedules/digest.md",
      '---\ncron: "30 2 * * *"\n---\nSummarize the CRM changes.\n',
    );
    await write(
      extensionPackageRoot,
      "extension/schedules/sync.ts",
      'import { defineSchedule } from "eve/schedules";\nexport default defineSchedule({ cron: "0 2 * * *", async run() {} });\n',
    );
    await write(
      extensionPackageRoot,
      "extension/subagents/reviewer/agent.ts",
      'import { defineAgent } from "eve";\nexport default defineAgent({ description: "Review CRM records.", model: "anthropic/claude-sonnet-5" });\n',
    );
    await write(
      extensionPackageRoot,
      "extension/subagents/quick.ts",
      'import { defineAgent } from "eve";\nexport default defineAgent({ description: "Quick CRM review.", model: "anthropic/claude-sonnet-5" });\n',
    );
  }
  await mkdir(path.join(extensionPackageRoot, "node_modules"), { recursive: true });
  await symlink(installedEveRoot, path.join(extensionPackageRoot, "node_modules/eve"));
}

async function writeConsumer(
  releaseDir: string,
  extensionPackageRoot: string,
  installedEveRoot = evePackageRoot,
  eveVersion = "0.45.2",
): Promise<void> {
  await write(
    releaseDir,
    "package.json",
    JSON.stringify({
      name: "extension-consumer",
      type: "module",
      dependencies: { eve: eveVersion, "@fixture/crm": "0.0.0" },
    }),
  );
  await write(releaseDir, "agent/instructions.md", "Use the CRM extension.");
  await write(releaseDir, "agent/extensions/crm.ts", 'export { default } from "@fixture/crm";\n');
  await mkdir(path.join(releaseDir, "node_modules/@fixture"), { recursive: true });
  await symlink(installedEveRoot, path.join(releaseDir, "node_modules/eve"));
  await symlink(extensionPackageRoot, path.join(releaseDir, "node_modules/@fixture/crm"));
}

async function write(root: string, relativePath: string, content: string): Promise<void> {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP port.");
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
      // Eve has not bound the production server yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}.`);
}
