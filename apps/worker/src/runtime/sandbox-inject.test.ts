import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  buildGeneratedSandboxModule,
  GENERATED_MODULE_MARKER,
  injectSandboxModules,
  resolveSandboxApi,
  resolveSandboxProcessLimits,
  resolveSandboxRunTimeoutMs,
  resolveSandboxRoots,
} from "./sandbox-inject.js";
import { SHIMMED_SANDBOX_ENTRY_POINTS } from "./sandbox-provider-modules.js";

async function makeRelease(
  eve = "0.62.0",
  { agent = true, providerEntry = true }: { agent?: boolean; providerEntry?: boolean } = {},
): Promise<{ releaseDir: string; backendDistDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "eveland-inject-"));
  const releaseDir = path.join(root, "release");
  const backendDistDir = path.join(root, "dist");
  await mkdir(agent ? path.join(releaseDir, "agent") : releaseDir, { recursive: true });
  await writeFile(path.join(releaseDir, "package.json"), JSON.stringify({ dependencies: { eve } }));
  await mkdir(backendDistDir, { recursive: true });
  await writeFile(path.join(backendDistDir, "index.js"), "export const marker = 1;\n");
  if (providerEntry) {
    await writeFile(path.join(backendDistDir, "provider.js"), "export const BwrapSandbox = {};\n");
  }
  return { releaseDir, backendDistDir };
}

describe("buildGeneratedSandboxModule", () => {
  test("gates on bwrap availability and forwards the cache dir", () => {
    const source = buildGeneratedSandboxModule("../.eveland/sandbox-bwrap/index.js");
    expect(source).toContain('from "eve/sandbox"');
    expect(source).toContain('from "../.eveland/sandbox-bwrap/index.js"');
    expect(source).toContain("isBwrapAvailable() ? bwrap(bwrapOptions) : defaultBackend()");
    expect(source).toContain("process.env.EVELAND_SANDBOX_CACHE_DIR");
  });

  test("starts with the generated-module marker so re-runs can recognize their own output", () => {
    const source = buildGeneratedSandboxModule("../.eveland/sandbox-bwrap/index.js");
    expect(source.startsWith(GENERATED_MODULE_MARKER)).toBe(true);
  });

  test("forwards the deployment template revision to the bwrap backend", () => {
    const source = buildGeneratedSandboxModule("../.eveland/sandbox-bwrap/index.js");

    expect(source).toContain("process.env.EVELAND_SANDBOX_TEMPLATE_REVISION");
    expect(source).toContain("templateRevision ? { templateRevision } : {}");
  });

  test("forwards the platform-owned hard run timeout to the bwrap backend", () => {
    const source = buildGeneratedSandboxModule("../.eveland/sandbox-bwrap/index.js");

    expect(source).toContain("process.env.EVELAND_SANDBOX_RUN_TIMEOUT_MS");
    expect(source).toContain("runTimeoutMs");
  });

  test("forwards platform-owned process and output limits to the bwrap backend", () => {
    const source = buildGeneratedSandboxModule("../.eveland/sandbox-bwrap/index.js");

    expect(source).toContain("process.env.EVELAND_SANDBOX_MAX_CONCURRENT_PROCESSES");
    expect(source).toContain("process.env.EVELAND_SANDBOX_MAX_OUTPUT_BYTES");
    expect(source).toContain("maxConcurrentProcesses");
    expect(source).toContain("maxOutputBytes");
  });

  test("preserves an authored definition while overriding only its backend", () => {
    const source = buildGeneratedSandboxModule(
      "../.eveland/sandbox-bwrap/index.js",
      "./.sandbox.eveland-authored.ts",
    );

    expect(source).toContain('import authoredSandbox from "./.sandbox.eveland-authored.ts";');
    expect(source).toContain("  ...authoredSandbox,");
    expect(source.indexOf("...authoredSandbox")).toBeLessThan(source.indexOf("backend:"));
  });
});

describe("resolveSandboxRunTimeoutMs", () => {
  test("defaults to ten minutes and keeps an explicit positive integer", () => {
    expect(resolveSandboxRunTimeoutMs({})).toBe("600000");
    expect(resolveSandboxRunTimeoutMs({ EVELAND_SANDBOX_RUN_TIMEOUT_MS: "120000" })).toBe("120000");
  });

  test.each(["0", "-1", "1.5", "not-a-number"])("rejects invalid value %s", (value) => {
    expect(() => resolveSandboxRunTimeoutMs({ EVELAND_SANDBOX_RUN_TIMEOUT_MS: value })).toThrow(
      /EVELAND_SANDBOX_RUN_TIMEOUT_MS/,
    );
  });
});

describe("resolveSandboxProcessLimits", () => {
  test("returns bounded defaults and keeps explicit positive integers", () => {
    expect(resolveSandboxProcessLimits({})).toEqual({
      maxConcurrentProcesses: "64",
      maxOutputBytes: "16777216",
    });
    expect(
      resolveSandboxProcessLimits({
        EVELAND_SANDBOX_MAX_CONCURRENT_PROCESSES: "8",
        EVELAND_SANDBOX_MAX_OUTPUT_BYTES: "1048576",
      }),
    ).toEqual({ maxConcurrentProcesses: "8", maxOutputBytes: "1048576" });
  });

  test.each([
    ["EVELAND_SANDBOX_MAX_CONCURRENT_PROCESSES", "0"],
    ["EVELAND_SANDBOX_MAX_CONCURRENT_PROCESSES", "1.5"],
    ["EVELAND_SANDBOX_MAX_OUTPUT_BYTES", "-1"],
    ["EVELAND_SANDBOX_MAX_OUTPUT_BYTES", "not-a-number"],
  ])("rejects invalid %s=%s", (name, value) => {
    expect(() => resolveSandboxProcessLimits({ [name]: value })).toThrow(name);
  });
});

describe("resolveSandboxRoots", () => {
  test("finds the agent root and every subagent", async () => {
    const { releaseDir } = await makeRelease();
    await mkdir(path.join(releaseDir, "agent", "subagents", "researcher"), { recursive: true });
    await mkdir(path.join(releaseDir, "agent", "subagents", "writer"), { recursive: true });
    const roots = await resolveSandboxRoots(releaseDir);
    expect(roots.sort()).toEqual(["agent", "agent/subagents/researcher", "agent/subagents/writer"]);
  });

  test("returns nothing when there is no agent directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eveland-inject-"));
    expect(await resolveSandboxRoots(root)).toEqual([]);
  });

  test("recurses into subagents of subagents, arbitrarily deep", async () => {
    const { releaseDir } = await makeRelease();
    await mkdir(path.join(releaseDir, "agent", "subagents", "outer", "subagents", "inner"), {
      recursive: true,
    });
    const roots = await resolveSandboxRoots(releaseDir);
    expect(roots.sort()).toEqual([
      "agent",
      "agent/subagents/outer",
      "agent/subagents/outer/subagents/inner",
    ]);
  });
});

describe("injectSandboxModules", () => {
  test("generates a sandbox module, vendors the backend, and reports nothing replaced", async () => {
    const { releaseDir, backendDistDir } = await makeRelease();
    const result = await injectSandboxModules({ releaseDir, backendDistDir });

    expect(result.api).toBe("backend");
    expect(result.generated).toEqual(["agent/sandbox.js"]);
    expect(result.replaced).toEqual([]);
    expect(existsSync(path.join(releaseDir, ".eveland", "sandbox-bwrap", "index.js"))).toBe(true);
    const generated = await readFile(path.join(releaseDir, "agent", "sandbox.js"), "utf8");
    expect(generated).toContain('from "../.eveland/sandbox-bwrap/index.js"');
  });

  test("wraps an authored sandbox module and reports its lifecycle as preserved", async () => {
    const { releaseDir, backendDistDir } = await makeRelease();
    const authored = `import { defineSandbox } from "eve/sandbox";
export default defineSandbox({
  backend: authoredBackend,
  bootstrap: async () => {},
  onSession: async () => {},
  revalidationKey: () => "authored-v1",
});
`;
    await writeFile(path.join(releaseDir, "agent", "sandbox.ts"), authored);

    const result = await injectSandboxModules({ releaseDir, backendDistDir });

    expect(result.wrapped).toEqual(["agent/sandbox.ts"]);
    expect(result.replaced).toEqual([]);
    expect(existsSync(path.join(releaseDir, "agent", "sandbox.ts"))).toBe(false);
    expect(existsSync(path.join(releaseDir, "agent", "sandbox.js"))).toBe(true);
    await expect(
      readFile(path.join(releaseDir, "agent", ".sandbox.eveland-authored.ts"), "utf8"),
    ).resolves.toBe(authored);
    await expect(readFile(path.join(releaseDir, "agent", "sandbox.js"), "utf8")).resolves.toContain(
      'import authoredSandbox from "./.sandbox.eveland-authored.ts";',
    );
  });

  test("preserves an authored workspace seed directory", async () => {
    const { releaseDir, backendDistDir } = await makeRelease();
    await mkdir(path.join(releaseDir, "agent", "sandbox", "workspace"), { recursive: true });
    await writeFile(
      path.join(releaseDir, "agent", "sandbox", "workspace", "knowledge.md"),
      "seeded\n",
    );

    const result = await injectSandboxModules({ releaseDir, backendDistDir });

    expect(result.wrapped).toEqual([]);
    expect(result.replaced).toEqual([]);
    expect(result.generated).toEqual(["agent/sandbox/sandbox.js"]);
    await expect(
      readFile(path.join(releaseDir, "agent", "sandbox", "workspace", "knowledge.md"), "utf8"),
    ).resolves.toBe("seeded\n");
    await expect(
      readFile(path.join(releaseDir, "agent", "sandbox", "sandbox.js"), "utf8"),
    ).resolves.toContain('from "../../.eveland/sandbox-bwrap/index.js"');
  });

  test("wraps an authored folder sandbox module without removing workspace seeds", async () => {
    const { releaseDir, backendDistDir } = await makeRelease();
    await mkdir(path.join(releaseDir, "agent", "sandbox", "workspace"), { recursive: true });
    await writeFile(
      path.join(releaseDir, "agent", "sandbox", "sandbox.ts"),
      "export default { bootstrap: async () => {}, onSession: async () => {} };\n",
    );
    await writeFile(
      path.join(releaseDir, "agent", "sandbox", "workspace", "knowledge.md"),
      "seeded\n",
    );

    const result = await injectSandboxModules({ releaseDir, backendDistDir });

    expect(result.wrapped).toEqual(["agent/sandbox/sandbox.ts"]);
    expect(result.replaced).toEqual([]);
    expect(result.generated).toEqual(["agent/sandbox/sandbox.js"]);
    expect(existsSync(path.join(releaseDir, "agent", "sandbox", "sandbox.ts"))).toBe(false);
    await expect(
      readFile(path.join(releaseDir, "agent", "sandbox", ".sandbox.eveland-authored.ts"), "utf8"),
    ).resolves.toContain("bootstrap");
    await expect(
      readFile(path.join(releaseDir, "agent", "sandbox", "sandbox.js"), "utf8"),
    ).resolves.toContain('import authoredSandbox from "./.sandbox.eveland-authored.ts";');
    await expect(
      readFile(path.join(releaseDir, "agent", "sandbox", "workspace", "knowledge.md"), "utf8"),
    ).resolves.toBe("seeded\n");
  });

  test("generates one module per subagent, each with a correct relative import", async () => {
    const { releaseDir, backendDistDir } = await makeRelease();
    await mkdir(path.join(releaseDir, "agent", "subagents", "researcher"), { recursive: true });

    const result = await injectSandboxModules({ releaseDir, backendDistDir });

    expect(result.generated.sort()).toEqual([
      "agent/sandbox.js",
      "agent/subagents/researcher/sandbox.js",
    ]);
    const sub = await readFile(
      path.join(releaseDir, "agent", "subagents", "researcher", "sandbox.js"),
      "utf8",
    );
    expect(sub).toContain('from "../../../.eveland/sandbox-bwrap/index.js"');
  });

  test("generates a module for nested subagents at any depth", async () => {
    const { releaseDir, backendDistDir } = await makeRelease();
    await mkdir(path.join(releaseDir, "agent", "subagents", "outer", "subagents", "inner"), {
      recursive: true,
    });

    const result = await injectSandboxModules({ releaseDir, backendDistDir });

    expect(result.generated.sort()).toEqual([
      "agent/sandbox.js",
      "agent/subagents/outer/sandbox.js",
      "agent/subagents/outer/subagents/inner/sandbox.js",
    ]);
    const inner = await readFile(
      path.join(releaseDir, "agent", "subagents", "outer", "subagents", "inner", "sandbox.js"),
      "utf8",
    );
    expect(inner).toContain('from "../../../../../.eveland/sandbox-bwrap/index.js"');
  });

  test("re-running is idempotent and does not report its own output as replaced", async () => {
    const { releaseDir, backendDistDir } = await makeRelease();
    await writeFile(path.join(releaseDir, "agent", "sandbox.ts"), "export default {};\n");
    const first = await injectSandboxModules({ releaseDir, backendDistDir });
    const second = await injectSandboxModules({ releaseDir, backendDistDir });
    expect(first.replaced).toEqual([]);
    expect(second.replaced).toEqual([]);
    expect(first.wrapped).toEqual(["agent/sandbox.ts"]);
    expect(second.wrapped).toEqual(["agent/sandbox.ts"]);
    expect(second.generated).toEqual(["agent/sandbox.js"]);
  });

  test("an authored sandbox.js is wrapped rather than confused with generated output", async () => {
    const { releaseDir, backendDistDir } = await makeRelease();
    await writeFile(path.join(releaseDir, "agent", "sandbox.js"), "export default {};\n");
    const result = await injectSandboxModules({ releaseDir, backendDistDir });
    expect(result.wrapped).toEqual(["agent/sandbox.js"]);
    expect(result.replaced).toEqual([]);
    await expect(
      readFile(path.join(releaseDir, "agent", ".sandbox.eveland-authored.js"), "utf8"),
    ).resolves.toBe("export default {};\n");
  });

  test("replaces rather than wraps a symlinked authored sandbox module", async () => {
    const { releaseDir, backendDistDir } = await makeRelease();
    const target = path.join(releaseDir, "outside-sandbox.ts");
    await writeFile(target, "export default {};\n");
    symlinkSync(target, path.join(releaseDir, "agent", "sandbox.ts"));

    const result = await injectSandboxModules({ releaseDir, backendDistDir });

    expect(result.wrapped).toEqual([]);
    expect(result.replaced).toEqual(["agent/sandbox.ts"]);
    expect(existsSync(path.join(releaseDir, "agent", ".sandbox.eveland-authored.ts"))).toBe(false);
  });

  test("an authored non-.js module is wrapped even when its content starts with the generated marker", async () => {
    const { releaseDir, backendDistDir } = await makeRelease();
    await writeFile(
      path.join(releaseDir, "agent", "sandbox.ts"),
      `${GENERATED_MODULE_MARKER} Do not edit.\nexport default {};\n`,
    );

    const result = await injectSandboxModules({ releaseDir, backendDistDir });

    expect(result.wrapped).toEqual(["agent/sandbox.ts"]);
    expect(result.replaced).toEqual([]);
  });

  test("removes and reports a symlinked sandbox directory regardless of type", async () => {
    const { releaseDir, backendDistDir } = await makeRelease();
    const targetDir = path.join(releaseDir, "sandbox-target");
    await mkdir(targetDir, { recursive: true });
    symlinkSync(targetDir, path.join(releaseDir, "agent", "sandbox"), "dir");

    const result = await injectSandboxModules({ releaseDir, backendDistDir });

    expect(result.replaced).toEqual(["agent/sandbox"]);
    expect(existsSync(path.join(releaseDir, "agent", "sandbox"))).toBe(false);
    expect(existsSync(path.join(releaseDir, "agent", "sandbox.js"))).toBe(true);
  });

  test("vendors the backend even when there is no agent directory (host capability, not project layout)", async () => {
    const { releaseDir, backendDistDir } = await makeRelease("0.62.0", { agent: false });

    const result = await injectSandboxModules({ releaseDir, backendDistDir });

    expect(result.generated).toEqual([]);
    expect(result.replaced).toEqual([]);
    expect(existsSync(path.join(releaseDir, ".eveland", "sandbox-bwrap", "index.js"))).toBe(true);
  });

  test("throws a clear error when the backend dist dir has no index.js", async () => {
    const { releaseDir, backendDistDir } = await makeRelease();
    await rm(path.join(backendDistDir, "index.js"));

    await expect(injectSandboxModules({ releaseDir, backendDistDir })).rejects.toThrow(
      /pnpm install/,
    );
  });
});

describe("resolveSandboxApi", () => {
  test.each([
    ["0.62.0", "backend"],
    ["^0.62.0", "backend"],
    ["0.62.x", "backend"],
    ["0.64.1", "provider"],
    ["~0.64.1", "provider"],
    ["0.64", "provider"],
    ["0.65.0", "provider"],
    ["0.65.*", "provider"],
    ["0.66.1", "provider"],
    ["0.66.*", "provider"],
  ])("a project declaring eve %s gets the %s sandbox shape", async (eve, api) => {
    const { releaseDir } = await makeRelease(eve);

    await expect(resolveSandboxApi(releaseDir)).resolves.toBe(api);
  });

  test("a declaration that does not name one minor line is refused, not guessed", async () => {
    for (const eve of [">=0.62.0", "latest", "*"]) {
      const { releaseDir } = await makeRelease(eve);
      await expect(resolveSandboxApi(releaseDir)).rejects.toThrow(/single Eve minor/);
    }
  });
});

describe("injectSandboxModules on Eve >= 0.64 (provider environments)", () => {
  const platformDir = (releaseDir: string) => path.join(releaseDir, ".eveland", "sandbox-platform");

  test("generates a provider module for an empty slot, plus the platform module and every shim", async () => {
    const { releaseDir, backendDistDir } = await makeRelease("0.66.1");

    const result = await injectSandboxModules({ releaseDir, backendDistDir });

    expect(result).toMatchObject({
      api: "provider",
      generated: ["agent/sandbox.js"],
      rewritten: [],
      replaced: [],
      wrapped: [],
    });
    const generated = await readFile(path.join(releaseDir, "agent", "sandbox.js"), "utf8");
    expect(generated.startsWith(GENERATED_MODULE_MARKER)).toBe(true);
    expect(generated).toContain('from "../.eveland/sandbox-platform/platform.js"');
    expect(generated).toContain("export const environment = platformEnvironment();");
    await expect(
      readFile(path.join(platformDir(releaseDir), "platform.js"), "utf8"),
    ).resolves.toContain('from "../sandbox-bwrap/provider.js"');
    for (const entryPoint of Object.keys(SHIMMED_SANDBOX_ENTRY_POINTS)) {
      expect(existsSync(path.join(platformDir(releaseDir), `${entryPoint}.js`)), entryPoint).toBe(
        true,
      );
    }
    expect(existsSync(path.join(releaseDir, ".eveland", "sandbox-bwrap", "provider.js"))).toBe(
      true,
    );
  });

  test("keeps an authored module in place and redirects its eve sandbox imports to the shims", async () => {
    const { releaseDir, backendDistDir } = await makeRelease("0.66.1");
    await writeFile(
      path.join(releaseDir, "agent", "sandbox.ts"),
      `import { defineSandbox } from "eve/sandbox";
import { DockerSandbox } from "eve/sandbox/docker";

export const environment = DockerSandbox.image("python:3.13", {
  prepare: async (sandbox) => {
    await sandbox.run({ command: "pip install requests" });
  },
});
export default defineSandbox(async () => {
  const sandbox = await environment.open();
  await sandbox.writeTextFile({ path: "ready.txt", content: "yes" });
  return sandbox;
});
`,
    );

    const result = await injectSandboxModules({ releaseDir, backendDistDir });

    expect(result).toMatchObject({ generated: [], rewritten: ["agent/sandbox.ts"], replaced: [] });
    expect(existsSync(path.join(releaseDir, "agent", "sandbox.js"))).toBe(false);
    const rewritten = await readFile(path.join(releaseDir, "agent", "sandbox.ts"), "utf8");
    expect(rewritten).toContain(
      'import { defineSandbox } from "../.eveland/sandbox-platform/sandbox.js";',
    );
    expect(rewritten).toContain(
      'import { DockerSandbox } from "../.eveland/sandbox-platform/docker.js";',
    );
    expect(rewritten).toContain('await sandbox.run({ command: "pip install requests" });');
  });

  test("uses eve's folder layout: rewrites the folder module, keeps seeds, drops the shadowed flat module", async () => {
    const { releaseDir, backendDistDir } = await makeRelease("0.66.1");
    await mkdir(path.join(releaseDir, "agent", "sandbox", "workspace"), { recursive: true });
    await writeFile(
      path.join(releaseDir, "agent", "sandbox", "sandbox.ts"),
      'import { DefaultSandbox, defineSandbox } from "eve/sandbox";\n' +
        "export const environment = DefaultSandbox.environment();\n" +
        "export default defineSandbox(() => environment.open());\n",
    );
    await writeFile(path.join(releaseDir, "agent", "sandbox", "workspace", "k.md"), "seeded\n");
    await writeFile(path.join(releaseDir, "agent", "sandbox.ts"), "export default {};\n");

    const result = await injectSandboxModules({ releaseDir, backendDistDir });

    expect(result).toMatchObject({
      generated: [],
      rewritten: ["agent/sandbox/sandbox.ts"],
      replaced: ["agent/sandbox.ts"],
    });
    await expect(
      readFile(path.join(releaseDir, "agent", "sandbox", "sandbox.ts"), "utf8"),
    ).resolves.toContain('from "../../.eveland/sandbox-platform/sandbox.js"');
    await expect(
      readFile(path.join(releaseDir, "agent", "sandbox", "workspace", "k.md"), "utf8"),
    ).resolves.toBe("seeded\n");
    expect(existsSync(path.join(releaseDir, "agent", "sandbox.ts"))).toBe(false);
  });

  test("generates into an empty sandbox folder so its workspace seeds still compile", async () => {
    const { releaseDir, backendDistDir } = await makeRelease("0.66.1");
    await mkdir(path.join(releaseDir, "agent", "sandbox", "workspace"), { recursive: true });

    const result = await injectSandboxModules({ releaseDir, backendDistDir });

    expect(result.generated).toEqual(["agent/sandbox/sandbox.js"]);
    await expect(
      readFile(path.join(releaseDir, "agent", "sandbox", "sandbox.js"), "utf8"),
    ).resolves.toContain('from "../../.eveland/sandbox-platform/platform.js"');
  });

  test("covers every subagent: a parent-sharing module is only redirected, an empty one is generated", async () => {
    const { releaseDir, backendDistDir } = await makeRelease("0.66.1");
    await mkdir(path.join(releaseDir, "agent", "subagents", "reviewer"), { recursive: true });
    await mkdir(path.join(releaseDir, "agent", "subagents", "researcher"), { recursive: true });
    await writeFile(
      path.join(releaseDir, "agent", "subagents", "reviewer", "sandbox.ts"),
      'import { defineParentSandbox } from "eve/sandbox";\nexport default defineParentSandbox();\n',
    );

    const result = await injectSandboxModules({ releaseDir, backendDistDir });

    expect([...result.generated].sort()).toEqual([
      "agent/sandbox.js",
      "agent/subagents/researcher/sandbox.js",
    ]);
    expect(result.rewritten).toEqual(["agent/subagents/reviewer/sandbox.ts"]);
    await expect(
      readFile(path.join(releaseDir, "agent", "subagents", "reviewer", "sandbox.ts"), "utf8"),
    ).resolves.toBe(
      'import { defineParentSandbox } from "../../../.eveland/sandbox-platform/sandbox.js";\n' +
        "export default defineParentSandbox();\n",
    );
  });

  test("leaves a custom provider import alone for the post-build check to refuse", async () => {
    const { releaseDir, backendDistDir } = await makeRelease("0.66.1");
    const authored =
      'import { defineSandbox } from "eve/sandbox";\n' +
      'import { defineSandboxProvider } from "eve/sandbox/provider";\n';
    await writeFile(path.join(releaseDir, "agent", "sandbox.ts"), authored);

    await injectSandboxModules({ releaseDir, backendDistDir });

    await expect(readFile(path.join(releaseDir, "agent", "sandbox.ts"), "utf8")).resolves.toBe(
      'import { defineSandbox } from "../.eveland/sandbox-platform/sandbox.js";\n' +
        'import { defineSandboxProvider } from "eve/sandbox/provider";\n',
    );
  });

  test("keeps only the module eve would load and reports the shadowed ones as replaced", async () => {
    const { releaseDir, backendDistDir } = await makeRelease("0.66.1");
    await writeFile(path.join(releaseDir, "agent", "sandbox.ts"), 'import "eve/sandbox";\n');
    await writeFile(path.join(releaseDir, "agent", "sandbox.js"), "export default {};\n");

    const result = await injectSandboxModules({ releaseDir, backendDistDir });

    expect(result).toMatchObject({
      rewritten: ["agent/sandbox.ts"],
      replaced: ["agent/sandbox.js"],
    });
    expect(existsSync(path.join(releaseDir, "agent", "sandbox.js"))).toBe(false);
  });

  test("replaces a symlinked authored module with a generated one", async () => {
    const { releaseDir, backendDistDir } = await makeRelease("0.66.1");
    const target = path.join(releaseDir, "outside-sandbox.ts");
    await writeFile(target, 'import "eve/sandbox";\n');
    symlinkSync(target, path.join(releaseDir, "agent", "sandbox.ts"));

    const result = await injectSandboxModules({ releaseDir, backendDistDir });

    expect(result).toMatchObject({
      generated: ["agent/sandbox.js"],
      rewritten: [],
      replaced: ["agent/sandbox.ts"],
    });
    await expect(readFile(target, "utf8")).resolves.toBe('import "eve/sandbox";\n');
  });

  test("re-running is idempotent for generated and authored modules alike", async () => {
    const { releaseDir, backendDistDir } = await makeRelease("0.66.1");
    await mkdir(path.join(releaseDir, "agent", "subagents", "researcher"), { recursive: true });
    await writeFile(
      path.join(releaseDir, "agent", "subagents", "researcher", "sandbox.ts"),
      'import { defineParentSandbox } from "eve/sandbox";\nexport default defineParentSandbox();\n',
    );

    const first = await injectSandboxModules({ releaseDir, backendDistDir });
    const snapshot = await readFile(
      path.join(releaseDir, "agent", "subagents", "researcher", "sandbox.ts"),
      "utf8",
    );
    const second = await injectSandboxModules({ releaseDir, backendDistDir });

    expect(second).toEqual(first);
    await expect(
      readFile(path.join(releaseDir, "agent", "subagents", "researcher", "sandbox.ts"), "utf8"),
    ).resolves.toBe(snapshot);
  });

  test("refuses a vendored sandbox-bwrap that predates the provider", async () => {
    const { releaseDir, backendDistDir } = await makeRelease("0.66.1", { providerEntry: false });

    await expect(injectSandboxModules({ releaseDir, backendDistDir })).rejects.toThrow(
      /sandbox-bwrap .*provider\.js/,
    );
  });
});
