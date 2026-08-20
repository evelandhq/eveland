import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { prepareReleaseTree } from "./prepare-release.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("copies source into a prepared release and injects observers without modifying the import", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eveland-release-"));
  roots.push(root);
  const sourcePath = path.join(root, "source");
  const buildDir = path.join(root, "build");
  await mkdir(path.join(sourcePath, "agent", "subagents", "child"), { recursive: true });
  await writeFile(
    path.join(sourcePath, "package.json"),
    JSON.stringify({ dependencies: { eve: "0.39.3" } }),
  );
  await writeFile(path.join(sourcePath, "agent", "instructions.md"), "root");
  await writeFile(
    path.join(sourcePath, "agent", "subagents", "child", "agent.ts"),
    "export default {}",
  );

  const result = await prepareReleaseTree({ sourcePath, buildDir });

  expect(result.injectedFiles).toEqual([
    "agent/hooks/eveland-observer.js",
    "agent/subagents/child/hooks/eveland-observer.js",
  ]);
  expect(result.runtimeFile).toBe(".eveland/observability/runtime.mjs");
  expect(result.extensionIntegratorFile).toBeUndefined();
  await expect(readFile(path.join(buildDir, result.injectedFiles[0]!), "utf8")).resolves.toContain(
    "../../.eveland/observability/runtime.mjs",
  );
  await expect(readFile(path.join(buildDir, result.runtimeFile!), "utf8")).resolves.toContain(
    "OTLPTraceExporter",
  );
  await expect(access(path.join(buildDir, ".eveland/extensions/integrate.mjs"))).rejects.toThrow();
  await expect(readFile(path.join(sourcePath, "agent", "instructions.md"), "utf8")).resolves.toBe(
    "root",
  );
});

test("injects the Extension integrator only when the source declares an Extension mount", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eveland-release-"));
  roots.push(root);
  const sourcePath = path.join(root, "source");
  const buildDir = path.join(root, "build");
  await mkdir(path.join(sourcePath, "agent", "extensions"), { recursive: true });
  await writeFile(
    path.join(sourcePath, "package.json"),
    JSON.stringify({ dependencies: { eve: "0.39.3" } }),
  );
  await writeFile(path.join(sourcePath, "agent", "instructions.md"), "root");
  await writeFile(
    path.join(sourcePath, "agent", "extensions", "crm.ts"),
    'export { default } from "@acme/crm";\n',
  );

  const result = await prepareReleaseTree({ sourcePath, buildDir });

  expect(result.extensionIntegratorFile).toBe(".eveland/extensions/integrate.mjs");
  await expect(
    readFile(path.join(buildDir, result.extensionIntegratorFile!), "utf8"),
  ).resolves.toContain("agent-discovery-manifest.json");
});

test("injects the scheduler adapter only into the disposable release", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eveland-release-"));
  roots.push(root);
  const sourcePath = path.join(root, "source");
  const buildDir = path.join(root, "build");
  await mkdir(path.join(sourcePath, "agent", "schedules"), { recursive: true });
  await writeFile(
    path.join(sourcePath, "package.json"),
    JSON.stringify({ dependencies: { eve: "0.39.3" } }),
  );
  await writeFile(path.join(sourcePath, "agent", "instructions.md"), "root");
  await writeFile(
    path.join(sourcePath, "agent", "schedules", "cleanup.ts"),
    'export default { cron: "0 3 * * *", async run() {} };',
  );

  const result = await prepareReleaseTree({ sourcePath, buildDir });

  expect(result.scheduler.definitions).toEqual([
    expect.objectContaining({ key: "cleanup", kind: "handler", cron: "0 3 * * *" }),
  ]);
  await expect(
    readFile(path.join(buildDir, "agent/channels/eveland-scheduler.ts"), "utf8"),
  ).resolves.toContain('kindHint: "schedule"');
  await expect(
    readFile(path.join(sourcePath, "agent/channels/eveland-scheduler.ts"), "utf8"),
  ).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("injects the platform workflow world into the prepared release while preserving the authored agent config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eveland-release-"));
  roots.push(root);
  const sourcePath = path.join(root, "source");
  const buildDir = path.join(root, "build");
  const authoredConfig = `import { model } from "./model.js";

export default {
  model,
  experimental: { workflow: { world: "@workflow/world-local" } },
};
`;
  await mkdir(path.join(sourcePath, "agent"), { recursive: true });
  await writeFile(
    path.join(sourcePath, "package.json"),
    JSON.stringify({ dependencies: { eve: "0.39.3" } }),
  );
  await writeFile(path.join(sourcePath, "agent", "instructions.md"), "root");
  await writeFile(path.join(sourcePath, "agent", "agent.ts"), authoredConfig);

  const result = await prepareReleaseTree({
    sourcePath,
    buildDir,
    workflowWorld: {
      packageName: "@workflow/world-postgres",
      packageVersion: "5.0.0-beta.34",
    },
  });

  expect(result.workflowWorld).toEqual({
    agentConfigPath: "agent/agent.ts",
    authoredConfigPath: "agent/eveland-authored-agent.ts",
  });
  await expect(
    readFile(path.join(buildDir, "agent", "eveland-authored-agent.ts"), "utf8"),
  ).resolves.toBe(authoredConfig);
  await expect(readFile(path.join(buildDir, "agent", "agent.ts"), "utf8")).resolves.toMatch(
    /world:\s*"@workflow\/world-postgres"/,
  );
  await expect(readFile(path.join(buildDir, "agent", "agent.ts"), "utf8")).resolves.toContain(
    'from "./eveland-authored-agent.ts"',
  );
  await expect(readFile(path.join(sourcePath, "agent", "agent.ts"), "utf8")).resolves.toBe(
    authoredConfig,
  );
  await expect(
    readFile(path.join(sourcePath, "agent", "eveland-authored-agent.ts"), "utf8"),
  ).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("creates a complete root config when the agent relied on Eve defaults", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eveland-release-"));
  roots.push(root);
  const sourcePath = path.join(root, "source");
  const buildDir = path.join(root, "build");
  await mkdir(path.join(sourcePath, "agent"), { recursive: true });
  await writeFile(
    path.join(sourcePath, "package.json"),
    JSON.stringify({ dependencies: { eve: "0.39.3" } }),
  );
  await writeFile(path.join(sourcePath, "agent", "instructions.md"), "root");

  const result = await prepareReleaseTree({
    sourcePath,
    buildDir,
    workflowWorld: {
      packageName: "@workflow/world-postgres",
      packageVersion: "5.0.0-beta.34",
    },
  });

  expect(result.workflowWorld).toEqual({ agentConfigPath: "agent/agent.ts" });
  const generated = await readFile(path.join(buildDir, "agent", "agent.ts"), "utf8");
  expect(generated).toContain('model: "anthropic/claude-sonnet-5"');
  expect(generated).toContain('world: "@workflow/world-postgres"');
  await expect(readFile(path.join(sourcePath, "agent", "agent.ts"), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("wraps every Eve-supported authored agent module extension", async () => {
  for (const extension of ["cts", "mts", "cjs", "mjs", "ts", "js"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "eveland-release-"));
    roots.push(root);
    const sourcePath = path.join(root, "source");
    const buildDir = path.join(root, "build");
    await mkdir(sourcePath, { recursive: true });
    await writeFile(
      path.join(sourcePath, "package.json"),
      JSON.stringify({ dependencies: { eve: "0.39.3" } }),
    );
    await writeFile(path.join(sourcePath, "instructions.md"), "root");
    await writeFile(
      path.join(sourcePath, `agent.${extension}`),
      "export default { model: 'openai/gpt-5.4' };\n",
    );

    const result = await prepareReleaseTree({
      sourcePath,
      buildDir,
      workflowWorld: {
        packageName: "@workflow/world-postgres",
        packageVersion: "5.0.0-beta.34",
      },
    });

    expect(result.workflowWorld).toEqual({
      agentConfigPath: "agent.ts",
      authoredConfigPath: `eveland-authored-agent.${extension}`,
    });
    await expect(readFile(path.join(buildDir, "agent.ts"), "utf8")).resolves.toContain(
      `from "./eveland-authored-agent.${extension}"`,
    );
  }
});
