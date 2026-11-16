import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import {
  bundleObserverRuntime,
  createObserverShim,
  injectExtensionSubagentHooks,
  injectObserverHooks,
} from "./injector.js";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, "..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("injectObserverHooks", () => {
  test("supported Eve minors give root and directory-form subagents hooks while file-form coverage is reported", async () => {
    const releaseDir = await createRelease();
    await write("agent/subagents/directory-child/agent.ts", "export default {}", releaseDir);
    await write("agent/subagents/file-child.ts", "export default {}", releaseDir);
    await write("agent/subagents/remote-child.ts", "export default {}", releaseDir);

    const result = await injectObserverHooks({ releaseDir });

    expect(result.injectedFiles).toEqual([
      "agent/hooks/eveland-observer.js",
      "agent/subagents/directory-child/hooks/eveland-observer.js",
      "agent/instrumentation/eveland-observer.js",
    ]);
    expect(result.runtimeFile).toBe(".eveland/observability/runtime.mjs");
    expect(result.coverageGaps.map((gap) => path.basename(gap.path))).toEqual([
      "file-child.ts",
      "remote-child.ts",
    ]);
    expect(result.observerContract).toBe(5);
    const rootShim = await readFile(path.join(releaseDir, result.injectedFiles[0]!), "utf8");
    expect(rootShim).toContain("file:///run/eveland/observability/runtime.mjs");
    expect(rootShim).toContain("../../.eveland/observability/runtime.mjs");
    expect(rootShim).toContain('import { defineHook } from "eve/hooks"');
    // The root names the file-form subagents eve runs without a hooks slot, by
    // the name it calls them; whether one is remote is the call's to say.
    expect(rootShim).toContain(
      'runtime?.observerHook({ unobservedSubagents: ["file-child","remote-child"] })',
    );
    const childShim = await readFile(path.join(releaseDir, result.injectedFiles[1]!), "utf8");
    expect(childShim).toContain("../../../../.eveland/observability/runtime.mjs");
    expect(childShim).toContain("defineHook(runtime?.default ??");
    // Instrumentation is root-only in eve and sees every session the process
    // runs, so one file covers the root and all of its subagents.
    const instrumentationShim = await readFile(
      path.join(releaseDir, result.injectedFiles[2]!),
      "utf8",
    );
    expect(instrumentationShim).toContain(
      'import { defineInstrumentation } from "eve/instrumentation"',
    );
    expect(instrumentationShim).toContain("file:///run/eveland/observability/runtime.mjs");
    expect(instrumentationShim).toContain("../../.eveland/observability/runtime.mjs");
  });

  test("fails instead of overwriting an authored reserved observer instrumentation file", async () => {
    const releaseDir = await createRelease();
    await write("agent/instrumentation/eveland-observer.ts", "authored", releaseDir);

    await expect(injectObserverHooks({ releaseDir })).rejects.toThrow(
      /Reserved instrumentation file agent\/instrumentation\/eveland-observer.ts already exists/,
    );
    await expect(
      readFile(path.join(releaseDir, "agent/instrumentation/eveland-observer.ts"), "utf8"),
    ).resolves.toBe("authored");
  });

  test("instrumentation shim observes provider calls without asking eve for content", async () => {
    const releaseDir = await createRelease();
    const result = await injectObserverHooks({ releaseDir });
    const instrumentationPath = path.join(releaseDir, "agent/instrumentation/eveland-observer.js");

    // A file's tracePolicy that admits content would widen what every AI SDK
    // telemetry integration in the process records, so it must admit none.
    const { stdout } = await execFileAsync(process.execPath, [
      "--input-type=module",
      "-e",
      `const shim = await import(${JSON.stringify(instrumentationPath)});
       const definition = shim.default;
       console.log(JSON.stringify({
         events: Object.keys(definition.events ?? {}).sort(),
         policy: definition.tracePolicy?.({}),
       }));`,
    ]);

    expect(result.injectedFiles).toContain("agent/instrumentation/eveland-observer.js");
    expect(JSON.parse(stdout.trim())).toEqual({
      events: ["model.call.settled", "model.call.started"],
      policy: { emit: true, recordInputs: false, recordOutputs: false },
    });
  });

  test("fails instead of overwriting an authored reserved observer hook", async () => {
    const releaseDir = await createRelease();
    await write("agent/hooks/eveland-observer.js", "authored", releaseDir);

    await expect(injectObserverHooks({ releaseDir })).rejects.toThrow(
      /Reserved observer hook already exists/,
    );
    await expect(
      readFile(path.join(releaseDir, "agent/hooks/eveland-observer.js"), "utf8"),
    ).resolves.toBe("authored");
  });

  test("does not modify user instrumentation or authored hooks", async () => {
    const releaseDir = await createRelease();
    const instrumentation = [
      'import { NodeSDK } from "@opentelemetry/sdk-node";',
      "const sdk = new NodeSDK();",
      "sdk.start();",
      "",
    ].join("\n");
    const authoredHook = 'export default { events: { "*": () => undefined } };\n';
    await write("instrumentation.ts", instrumentation, releaseDir);
    await write("agent/hooks/user-observer.ts", authoredHook, releaseDir);

    await injectObserverHooks({ releaseDir });

    await expect(readFile(path.join(releaseDir, "instrumentation.ts"), "utf8")).resolves.toBe(
      instrumentation,
    );
    await expect(
      readFile(path.join(releaseDir, "agent/hooks/user-observer.ts"), "utf8"),
    ).resolves.toBe(authoredHook);
  });

  test("bundles a self-contained private OTel runtime controlled only by its runtime policy", async () => {
    const releaseDir = await createRelease();
    const result = await injectObserverHooks({ releaseDir });
    const runtime = await readFile(path.join(releaseDir, result.runtimeFile!), "utf8");

    expect(runtime).toContain("OTLPTraceExporter");
    expect(runtime).toContain("/run/eveland/observability/agent-policy.json");
    // The bundle must load from the observability mount, where the Agent's
    // node_modules is not resolvable: nothing but node builtins may survive.
    expect(runtime).not.toContain('from "eve/hooks"');
    expect(runtime).not.toContain("EVELAND_TELEMETRY_ENABLED");
    expect(runtime).not.toContain('from "@evelandhq/');
    // Model ids come from eve's instrumentation events, not the AI SDK's
    // process-global telemetry registry.
    expect(runtime).not.toContain("AI_SDK_TELEMETRY_INTEGRATIONS");
  });

  test("shim falls back to the baked runtime when no platform runtime is mounted", async () => {
    const releaseDir = await createRelease();
    const result = await injectObserverHooks({ releaseDir });

    // Import the shim in a plain Node process, as Eve would -- vitest's module
    // pipeline would paper over bundling defects like an unshimmed CJS
    // require. /run/eveland is absent here, so this exercises the
    // baked-bundle fallback end to end.
    const { stdout } = await execFileAsync(process.execPath, [
      "--input-type=module",
      "-e",
      `const shim = await import(${JSON.stringify(
        path.join(releaseDir, result.injectedFiles[0]!),
      )}); console.log(typeof shim.default?.events?.["*"]);`,
    ]);

    expect(stdout.trim()).toBe("function");
  });

  test("bakes the identical bundle the Worker delivers into deployments", async () => {
    const releaseDir = await createRelease();
    const result = await injectObserverHooks({ releaseDir });
    const baked = await readFile(path.join(releaseDir, result.runtimeFile!), "utf8");

    await expect(bundleObserverRuntime()).resolves.toBe(baked);
  });
});

describe("injectExtensionSubagentHooks", () => {
  test("injects hooks into effective Extension subagents and their nested descendants", async () => {
    const releaseDir = await createRelease();
    await injectObserverHooks({ releaseDir });
    const extensionRoot = path.join(releaseDir, "node_modules/@acme/crm/dist/extension");
    const reviewerRoot = path.join(extensionRoot, "subagents/reviewer");
    const nestedRoot = path.join(reviewerRoot, "subagents/editor");
    await mkdir(reviewerRoot, { recursive: true });
    await writeFile(path.join(reviewerRoot, "agent.mjs"), "export default {}");
    await mkdir(nestedRoot, { recursive: true });
    await writeFile(path.join(nestedRoot, "agent.mjs"), "export default {}");
    const emptyManifest = (agentRoot: string): Record<string, unknown> => ({
      kind: "eve-agent-discovery-manifest",
      version: 13,
      agentId: "fixture",
      agentRoot,
      appRoot: releaseDir,
      channels: [],
      connections: [],
      diagnosticsSummary: { errors: 0, warnings: 0 },
      extensions: [],
      resolvedExtensions: [],
      hooks: [],
      instructions: [],
      lib: [],
      sandbox: null,
      sandboxWorkspaces: [],
      schedules: [],
      skills: [],
      tools: [],
      subagents: [],
    });
    const nestedManifest = emptyManifest(nestedRoot);
    const reviewerManifest = {
      ...emptyManifest(reviewerRoot),
      subagents: [
        {
          entryPath: nestedRoot,
          logicalPath: "subagents/editor",
          rootPath: reviewerRoot,
          sourceId: "subagents/editor",
          subagentId: "editor",
          manifest: nestedManifest,
        },
      ],
    };
    const manifest = {
      ...emptyManifest(path.join(releaseDir, "agent")),
      resolvedExtensions: [
        {
          namespace: "crm",
          specifier: "@acme/crm",
          packageName: "@acme/crm",
          packageRoot: path.join(releaseDir, "node_modules/@acme/crm"),
          sourceRoot: extensionRoot,
          manifest: {
            ...emptyManifest(extensionRoot),
            subagents: [
              {
                entryPath: reviewerRoot,
                logicalPath: "subagents/reviewer",
                rootPath: extensionRoot,
                sourceId: "subagents/reviewer",
                subagentId: "reviewer",
                manifest: reviewerManifest,
              },
            ],
          },
        },
      ],
    };

    const packageFilesBefore = await listFiles(path.join(releaseDir, "node_modules"));

    const result = await injectExtensionSubagentHooks({ releaseDir, manifest });

    expect(result.injectedFiles).toEqual([
      "node_modules/@acme/crm/dist/extension/subagents/reviewer/hooks/eveland-observer.js",
      "node_modules/@acme/crm/dist/extension/subagents/reviewer/subagents/editor/hooks/eveland-observer.js",
    ]);
    // The hook shims are the only files written into the installed package:
    // the shim loads the runtime from the platform mount and carries no copy.
    expect(await listFiles(path.join(releaseDir, "node_modules"))).toEqual(
      [
        ...packageFilesBefore,
        ...result.injectedFiles.map((file) => file.slice("node_modules/".length)),
      ].sort(),
    );
    const shim = await readFile(path.join(reviewerRoot, "hooks/eveland-observer.js"), "utf8");
    expect(shim).toContain("file:///run/eveland/observability/runtime.mjs");
    expect(shim).not.toContain(".eveland/observability/runtime.mjs");

    // Outside an Eveland deployment the mount is absent and the hook is inert.
    const { stdout } = await execFileAsync(process.execPath, [
      "--input-type=module",
      "-e",
      `const shim = await import(${JSON.stringify(path.join(reviewerRoot, "hooks/eveland-observer.js"))}); console.log(typeof shim.default?.events?.["*"]); await shim.default.events["*"]({ type: "turn.started" }, {});`,
    ]);
    expect(stdout.trim()).toBe("function");
  });

  test("an Extension hook shim runs the mounted platform runtime", async () => {
    const releaseDir = await createRelease();
    const observerPath = path.join(releaseDir, "agent/hooks/extension-observer.js");
    const platformRuntimePath = path.join(releaseDir, "mounted-runtime.mjs");
    await write(
      "mounted-runtime.mjs",
      'export default { events: { "*": function mounted() {} } };\n',
      releaseDir,
    );
    await write(
      "agent/hooks/extension-observer.js",
      createObserverShim(observerPath, undefined, new URL(`file://${platformRuntimePath}`).href),
      releaseDir,
    );

    const { stdout } = await execFileAsync(process.execPath, [
      "--input-type=module",
      "-e",
      `const shim = await import(${JSON.stringify(observerPath)}); console.log(shim.default?.events?.["*"]?.name);`,
    ]);
    expect(stdout.trim()).toBe("mounted");
  });

  test("names an Extension's file-form subagents in the hook of the agent that calls them", async () => {
    const releaseDir = await createRelease();
    await write("agent/subagents/local-file.ts", "export default {}", releaseDir);
    await injectObserverHooks({ releaseDir });
    const extensionRoot = path.join(releaseDir, "node_modules/@acme/crm/dist/extension");
    const reviewerRoot = path.join(extensionRoot, "subagents/reviewer");
    await mkdir(reviewerRoot, { recursive: true });
    const manifestOf = (agentRoot: string, extra: Record<string, unknown> = {}) => ({
      agentRoot,
      subagents: [],
      resolvedExtensions: [],
      ...extra,
    });
    const source = (entryPath: string, subagentId: string, manifest: unknown) => ({
      entryPath,
      logicalPath: path.basename(entryPath),
      subagentId,
      manifest,
    });
    const agentRoot = path.join(releaseDir, "agent");
    const manifest = manifestOf(agentRoot, {
      subagents: [
        source(
          path.join(agentRoot, "subagents/local-file.ts"),
          "local-file",
          manifestOf(agentRoot),
        ),
      ],
      resolvedExtensions: [
        {
          namespace: "crm",
          manifest: manifestOf(extensionRoot, {
            subagents: [
              source(
                path.join(extensionRoot, "subagents/quick.mjs"),
                "quick",
                manifestOf(extensionRoot),
              ),
              source(
                reviewerRoot,
                "reviewer",
                manifestOf(reviewerRoot, {
                  subagents: [
                    source(
                      path.join(reviewerRoot, "subagents/draft.mjs"),
                      "draft",
                      manifestOf(reviewerRoot),
                    ),
                  ],
                }),
              ),
            ],
          }),
        },
      ],
    });

    const result = await injectExtensionSubagentHooks({ releaseDir, manifest });

    expect(result.injectedFiles).toEqual([
      "node_modules/@acme/crm/dist/extension/subagents/reviewer/hooks/eveland-observer.js",
    ]);
    // The consumer's shim keeps its baked runtime and now names the mounted
    // file-form subagent under the mount's namespace beside its own.
    const rootShim = await readFile(path.join(agentRoot, "hooks/eveland-observer.js"), "utf8");
    expect(rootShim).toContain("../../.eveland/observability/runtime.mjs");
    expect(rootShim).toContain(
      'runtime?.observerHook({ unobservedSubagents: ["crm__quick","local-file"] })',
    );
    await expect(
      readFile(path.join(reviewerRoot, "hooks/eveland-observer.js"), "utf8"),
    ).resolves.toContain('runtime?.observerHook({ unobservedSubagents: ["draft"] })');
  });

  test("a hook shim hands the runtime its agent's unobserved subagents", async () => {
    const releaseDir = await createRelease();
    const observerPath = path.join(releaseDir, "agent/hooks/observer.js");
    const platformRuntimePath = path.join(releaseDir, "mounted-runtime.mjs");
    await write(
      "mounted-runtime.mjs",
      [
        "export function observerHook(options) {",
        "  const handler = () => {};",
        '  Object.defineProperty(handler, "name", { value: JSON.stringify(options) });',
        '  return { events: { "*": handler } };',
        "}",
        "",
      ].join("\n"),
      releaseDir,
    );
    await write(
      "agent/hooks/observer.js",
      createObserverShim(observerPath, undefined, new URL(`file://${platformRuntimePath}`).href, [
        "filechild",
        "crm__quick",
      ]),
      releaseDir,
    );

    const { stdout } = await execFileAsync(process.execPath, [
      "--input-type=module",
      "-e",
      `const shim = await import(${JSON.stringify(observerPath)}); console.log(shim.default?.events?.["*"]?.name);`,
    ]);
    expect(JSON.parse(stdout.trim())).toEqual({ unobservedSubagents: ["filechild", "crm__quick"] });
  });

  test("reports file-form coverage and rejects Extension subagent paths outside the Release", async () => {
    const releaseDir = await createRelease();
    await injectObserverHooks({ releaseDir });
    const emptyManifest = (agentRoot: string): Record<string, unknown> => ({
      agentRoot,
      subagents: [],
      resolvedExtensions: [],
    });
    const extensionRoot = path.join(releaseDir, "node_modules/@acme/crm/dist/extension");
    const manifestWith = (entryPath: string) => ({
      ...emptyManifest(path.join(releaseDir, "agent")),
      resolvedExtensions: [
        {
          namespace: "crm",
          manifest: {
            ...emptyManifest(extensionRoot),
            subagents: [
              {
                entryPath,
                logicalPath: "subagents/quick.mjs",
                subagentId: "quick",
                manifest: emptyManifest(extensionRoot),
              },
            ],
          },
        },
      ],
    });
    const fileForm = path.join(extensionRoot, "subagents/quick.mjs");
    const result = await injectExtensionSubagentHooks({
      releaseDir,
      manifest: manifestWith(fileForm),
    });
    expect(result.coverageGaps).toEqual([
      expect.objectContaining({ kind: "file-form-subagent", path: fileForm }),
    ]);

    await expect(
      injectExtensionSubagentHooks({
        releaseDir,
        manifest: manifestWith(path.join(path.dirname(releaseDir), "outside-subagent")),
      }),
    ).rejects.toThrow(/must stay inside the disposable Release directory/);
  });

  test("rejects bare-parent and symlinked Extension subagent paths that escape the Release", async () => {
    const releaseDir = await createRelease();
    await injectObserverHooks({ releaseDir });
    const emptyManifest = (agentRoot: string): Record<string, unknown> => ({
      agentRoot,
      subagents: [],
      resolvedExtensions: [],
    });
    const extensionRoot = path.join(releaseDir, "node_modules/@acme/crm/dist/extension");
    const manifestWith = (entryPath: string) => ({
      ...emptyManifest(path.join(releaseDir, "agent")),
      resolvedExtensions: [
        {
          namespace: "crm",
          manifest: {
            ...emptyManifest(extensionRoot),
            subagents: [
              {
                entryPath,
                logicalPath: "subagents/reviewer",
                subagentId: "reviewer",
                manifest: emptyManifest(extensionRoot),
              },
            ],
          },
        },
      ],
    });

    await expect(
      injectExtensionSubagentHooks({
        releaseDir,
        manifest: manifestWith(path.dirname(releaseDir)),
      }),
    ).rejects.toThrow(/must stay inside the disposable Release directory/);

    const outsideRoot = await mkdtemp(path.join(path.dirname(releaseDir), "observer-outside-"));
    temporaryDirectories.push(outsideRoot);
    await writeFile(path.join(outsideRoot, "agent.mjs"), "export default {}");
    const linkedRoot = path.join(
      releaseDir,
      "node_modules/@acme/crm/dist/extension/subagents/reviewer",
    );
    await mkdir(path.dirname(linkedRoot), { recursive: true });
    await symlink(outsideRoot, linkedRoot);
    await expect(
      injectExtensionSubagentHooks({ releaseDir, manifest: manifestWith(linkedRoot) }),
    ).rejects.toThrow(/must stay inside the disposable Release directory/);
  });
});

async function createRelease(): Promise<string> {
  const releaseDir = await mkdtemp(path.join(packageRoot, ".observer-test-"));
  temporaryDirectories.push(releaseDir);
  await write("agent/instructions.md", "fixture", releaseDir);
  return releaseDir;
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"),
    )
    .sort();
}

async function write(relativePath: string, content: string, root: string): Promise<void> {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}
