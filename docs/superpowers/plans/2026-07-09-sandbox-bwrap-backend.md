# @eveland/sandbox-bwrap (eve SandboxBackend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A publishable npm package `@eveland/sandbox-bwrap` implementing eve's public `SandboxBackend` interface on bubblewrap, so eve agents deployed on eveland's systemd runtime (Plan 1) get a working, isolated exec sandbox instead of the broken/degraded default chain.

**Architecture:** Directory-backed templates and sessions under `<appRoot>/.eve/sandbox-cache/bwrap/` (eve's local-backend cache convention). `prewarm` captures a template directory by running the authored `bootstrap` inside bwrap and writing seed files; `create` clones the template into a per-session workspace directory that persists across reconnects. Every `run`/`spawn` is one transient `bwrap` invocation: read-only host rootfs, the session directory bound read-write at `/workspace`, `/tmp` tmpfs, the sandbox cache root hidden via tmpfs, environment fully cleared and rebuilt from an explicit whitelist, and coarse network policy (`allow-all` shares the host netns, `deny-all` = `--unshare-net`). File I/O methods operate host-side on the session directory (no subprocess). All process execution goes through an injectable `ProcessRunner` so unit tests run on macOS without bwrap; the real-bwrap contract test runs in the Lima VM under the same systemd constraints as a deployed agent.

**Tech Stack:** TypeScript (strict, NodeNext, ESM), Node.js ≥24 builtins only at runtime (`node:child_process`, `node:fs`, `node:stream`, `node:crypto`), `eve` ^0.17.1 as peerDependency (types + `SandboxTemplateNotProvisionedError`), vitest ^4, tsx, bubblewrap ≥0.9 on the deploy host, Lima VM `eveland-test` for integration.

## Global Constraints

- Node `>=24.0.0`; package manager `pnpm@11.7.0`; workspace glob already covers `packages/*`.
- TypeScript strict, `module`/`moduleResolution` `NodeNext` (extend `tsconfig.base.json`); relative imports use `.js` extensions; ESM only (`"type": "module"`).
- The package has **zero runtime dependencies** — Node builtins only. `eve` is a peerDependency `^0.17.1` (devDependency `^0.17.1` for tests); `ai` `^7.0.7` is a devDependency (needed to elaborate eve's re-exported AI SDK types).
- Backend `name` is the frozen string `"bwrap"` — it participates in eve's cache-key derivation and persisted reconnect state; never change it.
- Workspace anchor is `/workspace` (eve's `WORKSPACE_ROOT`); relative paths resolve from it, absolute paths pass through.
- Commands run via `bash -lc <command>` (parity with eve's Docker backend).
- Every bwrap invocation MUST include `--clearenv` — the agent process env contains deployment secrets (Plan 1's `EnvironmentFile`); leaking it into sandboxed code would undo Plan 1's secret isolation.
- bwrap mount-arg ordering is load-bearing: tmpfs "hide" mounts come BEFORE the `/workspace` bind (bind sources resolve against the host filesystem, so a later bind punches through an earlier tmpfs — verified in Plan 1).
- Tests: vitest ^4.1.9, colocated `*.test.ts` next to sources, `import { describe, expect, test } from "vitest"`.
- Unit tests must pass on macOS (no bwrap): anything spawning bwrap goes through the injectable `ProcessRunner`.
- Git hygiene: work only in the dedicated worktree; never touch the main checkout; never use bare `git stash`.

## Context & References (read before implementing)

Why this exists: eveland deployments on the systemd runtime have no Docker daemon and no KVM, so eve's `defaultBackend()` chain (Vercel → Docker → microsandbox → just-bash) degrades to `justbash` — a pure-JS interpreter with a virtual FS that cannot run real binaries. Projects opt into this backend explicitly in `agent/sandbox.ts`.

eve internals to consult (in `/Users/michael/work/tmp/hello-world/node_modules/eve/dist/src/`, version 0.17.1 — reference only, we import solely from the public `eve/sandbox` subpath):

- `shared/sandbox-backend.d.ts` — `SandboxBackend`, `SandboxBackendHandle`, `SandboxBackendCreateInput` (note: `templateKey` may be `null`), `SandboxBackendPrewarmInput`, `SandboxSeedFile` (`content: string | Buffer`), `SandboxBackendRuntimeContext` (`appRoot`).
- `shared/sandbox-session.d.ts` — public `SandboxSession` = 8 AI SDK I/O methods + `id`, `resolvePath`, `setNetworkPolicy`, `removePath`. `readFile`/`readBinaryFile`/`readTextFile` resolve to `null` for missing files. `readTextFile`: `"utf-8"` decodes with `TextDecoder` in fatal mode, other encodings via `Buffer.toString(encoding)`; line ranges 1-based inclusive, `endLine` past EOF reads through EOF.
- `@ai-sdk/provider-utils` `dist/index.d.ts` lines ~1373–1548 — `SandboxProcessOptions` (`{command, workingDirectory?, env?, abortSignal?}`), `SandboxProcess` (`{pid?, stdout, stderr, wait(), kill()}`; wait resolves `{exitCode}`; on abort, `wait()` rejects with the abort reason; `kill()` idempotent). `run` returns `{exitCode, stdout, stderr}` and does NOT throw on non-zero exit.
- `execution/sandbox/bindings/docker-session.js` — behavior blueprint: `bash -lc` execution, exit-code-43 sentinel → `null` readFile, `mkdir -p && cat >` writeFile, `rm -rf --` removePath.
- `execution/sandbox/bindings/local-backend-utils.js` — `copyDirectoryAtomically` (cp to `<target>.<uuid>.tmp`, rename; on failure, success if target exists — concurrent-race tolerant), cache layout `<cacheDir>/<backend>/templates|sessions/<key>`.
- `internal/application/paths.d.ts` — eve's own local cache root is `<appRoot>/.eve/sandbox-cache`; we nest under it as `bwrap/`.
- `public/sandbox/index.d.ts` — everything we may import: `defineSandbox`, `defaultBackend`, `SandboxTemplateNotProvisionedError` (class with static `is()`; constructor takes `{backendName, templateKey}`), and all types above. `buildSandboxSession` is NOT exported — we implement the full public session surface ourselves.
- Docker backend parity notes: only `"allow-all"`/`"deny-all"` network policies; `dispose()` intentionally leaves the session runnable for instant reattach (ours: no-op — the workspace directory persists; bwrap processes die with the agent via `--die-with-parent`).

Plan 1 groundwork this builds on: bubblewrap is already provisioned in the Lima VM and documented as a host prereq (`docs/deploy/linux.md`); apt's bwrap on Ubuntu 23.10+ is non-setuid with an AppArmor profile permitting unprivileged user namespaces — which is what lets it run under the deployment unit's `NoNewPrivileges=yes`. Plan 1 only exercised bwrap as root (builds); **Task 5's smoke is the first verification as `eveland-app` under systemd hardening — treat a failure there as a finding, not something to hack around silently.**

File structure (all under `packages/sandbox-bwrap/`):

| File | Responsibility |
| --- | --- |
| `package.json`, `tsconfig.json`, `tsconfig.build.json` | Publishable ESM package; typecheck vs dist-emitting build |
| `src/options.ts` | Public factory options, defaults, options hash |
| `src/paths.ts` | Cache/template/session path derivation, `/workspace` anchoring, host-path translation, workspace containment check |
| `src/process.ts` | `ProcessRunner` abstraction, real Node child-process runner (pgroup kill, web streams, abort), `isBwrapAvailable` |
| `src/args.ts` | Pure bwrap argv builder (the security-critical surface, snapshot-pinned) |
| `src/session.ts` | Full public `SandboxSession` over one workspace dir |
| `src/backend.ts` | `SandboxBackend`: prewarm/create/handle |
| `src/index.ts` | Public exports incl. `bwrap()` factory |
| `src/integration/bwrap-backend-smoke.ts` | Real-bwrap contract test (Lima VM only) |
| `README.md` | Package docs for project authors |

---

### Task 1: Package scaffold, options, and path derivation

**Files:**
- Create: `packages/sandbox-bwrap/package.json`
- Create: `packages/sandbox-bwrap/tsconfig.json`
- Create: `packages/sandbox-bwrap/tsconfig.build.json`
- Create: `packages/sandbox-bwrap/src/options.ts`
- Create: `packages/sandbox-bwrap/src/paths.ts`
- Test: `packages/sandbox-bwrap/src/options.test.ts`
- Test: `packages/sandbox-bwrap/src/paths.test.ts`
- Modify: `pnpm-lock.yaml` (via `pnpm install`)

**Interfaces:**
- Consumes: nothing (first task).
- Produces (later tasks import these exact names from `./options.js` / `./paths.js`):
  - `type BwrapNetworkPolicy = "allow-all" | "deny-all"`
  - `interface BwrapSandboxCreateOptions { env?; networkPolicy?; hidePaths?; bwrapPath? }`
  - `interface ResolvedBwrapSandboxOptions { env: Readonly<Record<string,string>>; networkPolicy: BwrapNetworkPolicy; hidePaths: readonly string[]; bwrapPath: string }`
  - `resolveBwrapSandboxOptions(options?: BwrapSandboxCreateOptions): ResolvedBwrapSandboxOptions`
  - `createBwrapOptionsHash(options: ResolvedBwrapSandboxOptions): string` (16 hex chars)
  - `const WORKSPACE_ROOT = "/workspace"`
  - `resolveBwrapCacheRoot(appRoot: string): string`
  - `resolveTemplatePath(appRoot: string, templateKey: string, optionsHash: string): string`
  - `resolveSessionPath(appRoot: string, sessionKey: string): string`
  - `resolveWorkspacePath(path: string): string`
  - `toHostPath(path: string, workspaceDir: string): string`
  - `isWithinWorkspace(hostPath: string, workspaceDir: string): boolean`

- [ ] **Step 1: Create the package manifest and tsconfigs**

`packages/sandbox-bwrap/package.json`:

```json
{
  "name": "@eveland/sandbox-bwrap",
  "version": "0.1.0",
  "description": "bubblewrap SandboxBackend for eve agents — real exec sandboxing without Docker or KVM",
  "type": "module",
  "license": "MIT",
  "files": ["dist", "README.md"],
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "engines": {
    "node": ">=24.0.0"
  },
  "os": ["linux"],
  "peerDependencies": {
    "eve": "^0.17.1"
  },
  "devDependencies": {
    "ai": "^7.0.7",
    "eve": "^0.17.1",
    "vitest": "^4.1.9"
  }
}
```

Note: `"os": ["linux"]` documents intent for npm, but pnpm install on macOS still works for dev because it is not in `dependencies` of any app. If `pnpm install` refuses on macOS because of the `os` field, delete the `os` field rather than fighting it.

`packages/sandbox-bwrap/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src"]
}
```

`packages/sandbox-bwrap/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "declaration": true,
    "types": ["node"]
  },
  "exclude": ["src/**/*.test.ts", "src/integration"]
}
```

- [ ] **Step 2: Install workspace dependencies**

Run from the repo root: `pnpm install`
Expected: succeeds; lockfile gains `eve@0.17.1` and `ai@7.x` under the new package. eve declares many optional peers (react, next, vue, …) — pnpm peer-dependency warnings about those are expected and ignorable. Commit the lockfile with this task.

- [ ] **Step 3: Write failing tests for options**

`packages/sandbox-bwrap/src/options.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { createBwrapOptionsHash, resolveBwrapSandboxOptions } from "./options.js";

describe("resolveBwrapSandboxOptions", () => {
  test("applies defaults", () => {
    expect(resolveBwrapSandboxOptions()).toEqual({
      env: {},
      networkPolicy: "allow-all",
      hidePaths: [],
      bwrapPath: "bwrap",
    });
  });

  test("keeps explicit values", () => {
    const resolved = resolveBwrapSandboxOptions({
      env: { FOO: "1" },
      networkPolicy: "deny-all",
      hidePaths: ["/srv/private"],
      bwrapPath: "/usr/bin/bwrap",
    });
    expect(resolved.networkPolicy).toBe("deny-all");
    expect(resolved.env).toEqual({ FOO: "1" });
    expect(resolved.hidePaths).toEqual(["/srv/private"]);
    expect(resolved.bwrapPath).toBe("/usr/bin/bwrap");
  });
});

describe("createBwrapOptionsHash", () => {
  test("is stable across env key ordering and distinct for different options", () => {
    const a = createBwrapOptionsHash(resolveBwrapSandboxOptions({ env: { A: "1", B: "2" } }));
    const b = createBwrapOptionsHash(resolveBwrapSandboxOptions({ env: { B: "2", A: "1" } }));
    const c = createBwrapOptionsHash(resolveBwrapSandboxOptions({ env: { A: "1", B: "3" } }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm --filter @eveland/sandbox-bwrap test`
Expected: FAIL — cannot resolve `./options.js`.

- [ ] **Step 5: Implement options**

`packages/sandbox-bwrap/src/options.ts`:

```ts
import { createHash } from "node:crypto";

/** Coarse egress control, matching what eve's Docker backend supports. */
export type BwrapNetworkPolicy = "allow-all" | "deny-all";

/** Options accepted by `bwrap(opts)`. */
export interface BwrapSandboxCreateOptions {
  /** Environment variables set for every command the backend runs. */
  readonly env?: Readonly<Record<string, string>>;
  /** Initial network policy for sandboxed commands. Defaults to `"allow-all"`. */
  readonly networkPolicy?: BwrapNetworkPolicy;
  /** Extra host paths hidden from the sandbox (each mounted over with an empty tmpfs). */
  readonly hidePaths?: readonly string[];
  /** bwrap executable path. Defaults to `"bwrap"` resolved via PATH. */
  readonly bwrapPath?: string;
}

/** Fully-defaulted options consumed by the backend implementation. */
export interface ResolvedBwrapSandboxOptions {
  readonly env: Readonly<Record<string, string>>;
  readonly networkPolicy: BwrapNetworkPolicy;
  readonly hidePaths: readonly string[];
  readonly bwrapPath: string;
}

export function resolveBwrapSandboxOptions(options: BwrapSandboxCreateOptions = {}): ResolvedBwrapSandboxOptions {
  return {
    env: options.env ?? {},
    networkPolicy: options.networkPolicy ?? "allow-all",
    hidePaths: options.hidePaths ?? [],
    bwrapPath: options.bwrapPath ?? "bwrap",
  };
}

/**
 * Hash of the resolved options. Participates in template path derivation so
 * templates captured under different options never mix (parity with the
 * Docker backend's options hash).
 */
export function createBwrapOptionsHash(options: ResolvedBwrapSandboxOptions): string {
  const canonical = JSON.stringify({
    bwrapPath: options.bwrapPath,
    env: Object.fromEntries(Object.entries(options.env).sort(([a], [b]) => (a < b ? -1 : 1))),
    hidePaths: [...options.hidePaths],
    networkPolicy: options.networkPolicy,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
```

- [ ] **Step 6: Write failing tests for paths**

`packages/sandbox-bwrap/src/paths.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  isWithinWorkspace,
  resolveBwrapCacheRoot,
  resolveSessionPath,
  resolveTemplatePath,
  resolveWorkspacePath,
  toHostPath,
  WORKSPACE_ROOT,
} from "./paths.js";

describe("cache layout", () => {
  test("nests under eve's local sandbox cache convention", () => {
    expect(resolveBwrapCacheRoot("/app")).toBe("/app/.eve/sandbox-cache/bwrap");
  });

  test("template paths are hash-keyed and options-scoped", () => {
    const a = resolveTemplatePath("/app", "tpl-key", "aaaa");
    const b = resolveTemplatePath("/app", "tpl-key", "bbbb");
    const c = resolveTemplatePath("/app", "other-key", "aaaa");
    expect(a).toMatch(/^\/app\/\.eve\/sandbox-cache\/bwrap\/templates\/[0-9a-f]{32}-aaaa$/);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  test("session paths are keyed by session key only", () => {
    expect(resolveSessionPath("/app", "sess/with:odd chars")).toMatch(
      /^\/app\/\.eve\/sandbox-cache\/bwrap\/sessions\/[0-9a-f]{32}$/,
    );
  });
});

describe("workspace paths", () => {
  test("anchors relative paths to /workspace and passes absolute through", () => {
    expect(resolveWorkspacePath("notes/a.txt")).toBe("/workspace/notes/a.txt");
    expect(resolveWorkspacePath("/etc/hosts")).toBe("/etc/hosts");
    expect(WORKSPACE_ROOT).toBe("/workspace");
  });

  test("translates workspace paths to host paths", () => {
    expect(toHostPath("notes/a.txt", "/data/sess1")).toBe("/data/sess1/notes/a.txt");
    expect(toHostPath("/workspace", "/data/sess1")).toBe("/data/sess1");
    expect(toHostPath("/workspace/x", "/data/sess1")).toBe("/data/sess1/x");
    expect(toHostPath("/etc/hosts", "/data/sess1")).toBe("/etc/hosts");
  });

  test("containment check rejects escapes", () => {
    expect(isWithinWorkspace("/data/sess1/notes", "/data/sess1")).toBe(true);
    expect(isWithinWorkspace("/data/sess1", "/data/sess1")).toBe(true);
    expect(isWithinWorkspace("/data/other", "/data/sess1")).toBe(false);
    // traversal normalizes out of the workspace
    expect(isWithinWorkspace(toHostPath("a/../../escape", "/data/sess1"), "/data/sess1")).toBe(false);
  });
});
```

- [ ] **Step 7: Run tests to verify the new file fails**

Run: `pnpm --filter @eveland/sandbox-bwrap test`
Expected: options tests PASS, paths tests FAIL (module not found).

- [ ] **Step 8: Implement paths**

`packages/sandbox-bwrap/src/paths.ts`:

```ts
import { createHash } from "node:crypto";
import { isAbsolute, join, relative } from "node:path";

/** Sandbox-visible workspace root; parity with eve's built-in local backends. */
export const WORKSPACE_ROOT = "/workspace";

/** Matches eve's local sandbox cache convention: <appRoot>/.eve/sandbox-cache/<backend>. */
export function resolveBwrapCacheRoot(appRoot: string): string {
  return join(appRoot, ".eve", "sandbox-cache", "bwrap");
}

function keyDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function resolveTemplatePath(appRoot: string, templateKey: string, optionsHash: string): string {
  return join(resolveBwrapCacheRoot(appRoot), "templates", `${keyDigest(templateKey)}-${optionsHash}`);
}

export function resolveSessionPath(appRoot: string, sessionKey: string): string {
  return join(resolveBwrapCacheRoot(appRoot), "sessions", keyDigest(sessionKey));
}

/** Anchors a sandbox-relative path to /workspace; absolute paths pass through. */
export function resolveWorkspacePath(path: string): string {
  return path.startsWith("/") ? path : `${WORKSPACE_ROOT}/${path}`;
}

/**
 * Translates a sandbox-visible path to the host path backing it: /workspace
 * maps to the session directory, anything else is the same path on the host.
 */
export function toHostPath(path: string, workspaceDir: string): string {
  const resolved = resolveWorkspacePath(path);
  if (resolved === WORKSPACE_ROOT) return workspaceDir;
  if (resolved.startsWith(`${WORKSPACE_ROOT}/`)) {
    return join(workspaceDir, resolved.slice(WORKSPACE_ROOT.length + 1));
  }
  return resolved;
}

/** True when hostPath is workspaceDir or inside it after normalization. */
export function isWithinWorkspace(hostPath: string, workspaceDir: string): boolean {
  const rel = relative(workspaceDir, hostPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
```

- [ ] **Step 9: Run tests and typecheck**

Run: `pnpm --filter @eveland/sandbox-bwrap test && pnpm --filter @eveland/sandbox-bwrap typecheck`
Expected: all PASS, typecheck clean.

- [ ] **Step 10: Commit**

```bash
git add packages/sandbox-bwrap pnpm-lock.yaml
git commit -m "feat(sandbox-bwrap): scaffold package with options and cache path derivation"
```

---

### Task 2: Process runner and bwrap argv builder

**Files:**
- Create: `packages/sandbox-bwrap/src/process.ts`
- Create: `packages/sandbox-bwrap/src/args.ts`
- Test: `packages/sandbox-bwrap/src/process.test.ts`
- Test: `packages/sandbox-bwrap/src/args.test.ts`

**Interfaces:**
- Consumes: `WORKSPACE_ROOT` from `./paths.js` (Task 1).
- Produces:
  - `interface SpawnedProcess { pid?: number; stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; wait(): Promise<{exitCode: number}>; kill(): Promise<void> }`
  - `interface ProcessRunner { spawn(argv: readonly string[], options?: {abortSignal?: AbortSignal}): SpawnedProcess }`
  - `createNodeProcessRunner(): ProcessRunner`
  - `isBwrapAvailable(bwrapPath?: string): boolean`
  - `const DEFAULT_SANDBOX_PATH: string`
  - `interface BwrapExecInput { bwrapPath; workspaceDir; hidePaths; shareNetwork; env; chdir; command }`
  - `buildBwrapExecArgs(input: BwrapExecInput): string[]` (full argv including the bwrap executable at index 0)

- [ ] **Step 1: Write failing tests for the argv builder**

`packages/sandbox-bwrap/src/args.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { buildBwrapExecArgs, DEFAULT_SANDBOX_PATH } from "./args.js";

describe("buildBwrapExecArgs", () => {
  test("pins the exact sandbox argv (order is load-bearing)", () => {
    const args = buildBwrapExecArgs({
      bwrapPath: "bwrap",
      workspaceDir: "/app/.eve/sandbox-cache/bwrap/sessions/abc",
      hidePaths: ["/app/.eve/sandbox-cache/bwrap"],
      shareNetwork: true,
      env: { PATH: DEFAULT_SANDBOX_PATH, HOME: "/workspace" },
      chdir: "/workspace",
      command: "echo hi",
    });

    expect(args).toEqual([
      "bwrap",
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      "--proc", "/proc",
      "--tmpfs", "/tmp",
      "--tmpfs", "/app/.eve/sandbox-cache/bwrap",
      "--bind", "/app/.eve/sandbox-cache/bwrap/sessions/abc", "/workspace",
      "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--die-with-parent",
      "--clearenv",
      "--setenv", "PATH", DEFAULT_SANDBOX_PATH,
      "--setenv", "HOME", "/workspace",
      "--chdir", "/workspace",
      "bash", "-lc", "echo hi",
    ]);
  });

  test("deny-all adds --unshare-net after the workspace bind", () => {
    const args = buildBwrapExecArgs({
      bwrapPath: "bwrap",
      workspaceDir: "/w",
      hidePaths: [],
      shareNetwork: false,
      env: {},
      chdir: "/workspace",
      command: "true",
    });
    const bindIndex = args.indexOf("--bind");
    const unshareNetIndex = args.indexOf("--unshare-net");
    expect(unshareNetIndex).toBeGreaterThan(bindIndex);
    expect(args).toContain("--clearenv");
  });

  test("tmpfs hides come before the workspace bind so the bind punches through", () => {
    const args = buildBwrapExecArgs({
      bwrapPath: "bwrap",
      workspaceDir: "/data/cache/sessions/s1",
      hidePaths: ["/data/cache", "/srv/private"],
      shareNetwork: true,
      env: {},
      chdir: "/workspace",
      command: "true",
    });
    const lastTmpfs = args.lastIndexOf("--tmpfs");
    expect(lastTmpfs).toBeLessThan(args.indexOf("--bind"));
    expect(args.slice(lastTmpfs, lastTmpfs + 2)).toEqual(["--tmpfs", "/srv/private"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @eveland/sandbox-bwrap test`
Expected: FAIL — `./args.js` not found.

- [ ] **Step 3: Implement the argv builder**

`packages/sandbox-bwrap/src/args.ts`:

```ts
import { WORKSPACE_ROOT } from "./paths.js";

/** PATH the sandbox sees; the host rootfs is visible read-only, so the standard dirs apply. */
export const DEFAULT_SANDBOX_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export interface BwrapExecInput {
  readonly bwrapPath: string;
  readonly workspaceDir: string;
  /** Host paths mounted over with an empty tmpfs. Caller filters to existing paths. */
  readonly hidePaths: readonly string[];
  readonly shareNetwork: boolean;
  /** Final merged environment; with --clearenv the sandbox sees exactly these variables. */
  readonly env: Readonly<Record<string, string>>;
  /** Sandbox-visible working directory (already /workspace-anchored). */
  readonly chdir: string;
  readonly command: string;
}

export function buildBwrapExecArgs(input: BwrapExecInput): string[] {
  const args = [
    input.bwrapPath,
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
  ];
  // Hide paths BEFORE re-binding the workspace: bind sources resolve against
  // the host filesystem, so a later bind punches through an earlier tmpfs.
  for (const path of input.hidePaths) {
    args.push("--tmpfs", path);
  }
  args.push("--bind", input.workspaceDir, WORKSPACE_ROOT);
  if (!input.shareNetwork) {
    args.push("--unshare-net");
  }
  args.push("--unshare-pid", "--unshare-ipc", "--unshare-uts", "--die-with-parent", "--clearenv");
  for (const [key, value] of Object.entries(input.env)) {
    args.push("--setenv", key, value);
  }
  args.push("--chdir", input.chdir, "bash", "-lc", input.command);
  return args;
}
```

- [ ] **Step 4: Run tests to verify args pass**

Run: `pnpm --filter @eveland/sandbox-bwrap test`
Expected: args tests PASS.

- [ ] **Step 5: Write failing tests for the process runner**

The runner is a generic argv spawner — tests run plain `sh` on macOS; only production callers prepend bwrap argv.

`packages/sandbox-bwrap/src/process.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { createNodeProcessRunner, isBwrapAvailable } from "./process.js";

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

describe("createNodeProcessRunner", () => {
  const runner = createNodeProcessRunner();

  test("captures stdout, stderr, and the exit code", async () => {
    const proc = runner.spawn(["sh", "-c", "echo out; echo err >&2; exit 7"]);
    const [stdout, stderr, result] = await Promise.all([readAll(proc.stdout), readAll(proc.stderr), proc.wait()]);
    expect(stdout).toBe("out\n");
    expect(stderr).toBe("err\n");
    expect(result.exitCode).toBe(7);
  });

  test("kill terminates the whole process group promptly and is idempotent", async () => {
    const proc = runner.spawn(["sh", "-c", "sleep 30"]);
    const started = Date.now();
    await proc.kill();
    await proc.kill();
    await proc.wait().catch(() => undefined);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("abort makes wait() reject with the abort reason", async () => {
    const controller = new AbortController();
    const proc = runner.spawn(["sh", "-c", "sleep 30"], { abortSignal: controller.signal });
    const waiting = proc.wait();
    controller.abort(new Error("stop-now"));
    await expect(waiting).rejects.toThrow("stop-now");
  });

  test("spawning a missing executable rejects wait()", async () => {
    const proc = runner.spawn(["definitely-not-a-real-binary-xyz"]);
    await expect(proc.wait()).rejects.toThrow();
  });
});

describe("isBwrapAvailable", () => {
  test("returns false for a missing binary", () => {
    expect(isBwrapAvailable("definitely-not-a-real-binary-xyz")).toBe(false);
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `pnpm --filter @eveland/sandbox-bwrap test`
Expected: FAIL — `./process.js` not found.

- [ ] **Step 7: Implement the process runner**

`packages/sandbox-bwrap/src/process.ts`:

```ts
import { spawn, spawnSync } from "node:child_process";
import { Readable } from "node:stream";

/** Mirrors the AI SDK SandboxProcess surface so sessions can return it directly. */
export interface SpawnedProcess {
  readonly pid?: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  wait(): Promise<{ exitCode: number }>;
  kill(): Promise<void>;
}

/** Injectable process launcher so backend logic is unit-testable without bwrap. */
export interface ProcessRunner {
  spawn(argv: readonly string[], options?: { readonly abortSignal?: AbortSignal }): SpawnedProcess;
}

const SIGNAL_EXIT_CODES: Record<string, number> = { SIGINT: 130, SIGKILL: 137, SIGTERM: 143 };

export function isBwrapAvailable(bwrapPath = "bwrap"): boolean {
  return spawnSync(bwrapPath, ["--version"], { stdio: "ignore" }).status === 0;
}

export function createNodeProcessRunner(): ProcessRunner {
  return {
    spawn(argv, options) {
      const [command, ...rest] = argv;
      if (!command) {
        throw new Error("ProcessRunner.spawn requires a non-empty argv");
      }
      // detached: the child leads its own process group, so kill(-pid) reaps
      // the entire sandboxed tree (bwrap and everything inside it).
      const child = spawn(command, rest, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const exit = new Promise<{ exitCode: number }>((resolvePromise, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          resolvePromise({ exitCode: code ?? (signal ? (SIGNAL_EXIT_CODES[signal] ?? 1) : 1) });
        });
      });
      exit.catch(() => {});
      const killTree = () => {
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
            return;
          } catch {
            // fall through: group already gone or not yet set up
          }
        }
        child.kill("SIGKILL");
      };
      let aborted = false;
      let abortReason: unknown;
      const signal = options?.abortSignal;
      if (signal) {
        const onAbort = () => {
          aborted = true;
          abortReason = signal.reason;
          killTree();
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      return {
        pid: child.pid,
        stdout: Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr) as unknown as ReadableStream<Uint8Array>,
        async wait() {
          const result = await exit;
          if (aborted) throw abortReason;
          return result;
        },
        async kill() {
          killTree();
          await exit.catch(() => {});
        },
      };
    },
  };
}
```

- [ ] **Step 8: Run tests and typecheck**

Run: `pnpm --filter @eveland/sandbox-bwrap test && pnpm --filter @eveland/sandbox-bwrap typecheck`
Expected: all PASS. If the missing-executable test hangs instead of rejecting, the `error` event handler is not wired to the exit promise — fix, don't skip.

- [ ] **Step 9: Commit**

```bash
git add packages/sandbox-bwrap/src
git commit -m "feat(sandbox-bwrap): process runner and sandbox argv builder"
```

---

### Task 3: The sandbox session

**Files:**
- Create: `packages/sandbox-bwrap/src/session.ts`
- Test: `packages/sandbox-bwrap/src/session.test.ts`

**Interfaces:**
- Consumes: Task 1 (`ResolvedBwrapSandboxOptions`, path helpers) and Task 2 (`ProcessRunner`, `buildBwrapExecArgs`, `DEFAULT_SANDBOX_PATH`).
- Produces:
  - `interface CreateBwrapSessionInput { id: string; workspaceDir: string; appRoot: string; runner: ProcessRunner; options: ResolvedBwrapSandboxOptions }`
  - `createBwrapSession(input: CreateBwrapSessionInput): SandboxSession` — the full public eve session (`run`, `spawn`, `readFile`, `readBinaryFile`, `readTextFile`, `writeFile`, `writeBinaryFile`, `writeTextFile`, `removePath`, `resolvePath`, `setNetworkPolicy`, `id`).

Behavioral contract (from eve's docs and Docker-backend parity):
- File I/O runs host-side against `workspaceDir` — no subprocess. Reads of missing files resolve `null`. Writes create parent directories recursively.
- Writes and removes are refused (throw `Error`) when the translated host path escapes `workspaceDir`. Reads of non-workspace absolute paths pass through to the host filesystem (the sandbox sees the same bytes read-only).
- `run` wraps `spawn`: collect both streams, await `wait()`, return `{exitCode, stdout, stderr}`; never throws on non-zero exit.
- `setNetworkPolicy` accepts only `"allow-all"`/`"deny-all"`; the policy applies to subsequent `run`/`spawn` calls (each call is a fresh bwrap invocation). Granular policies throw.
- Every spawn hides `resolveBwrapCacheRoot(appRoot)` plus configured `hidePaths` (filtered to existing paths), and builds env as: defaults (`PATH`, `HOME=/workspace`, `LANG=C.UTF-8`) ← factory `env` ← per-call `env`.

- [ ] **Step 1: Write failing tests**

`packages/sandbox-bwrap/src/session.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { resolveBwrapSandboxOptions } from "./options.js";
import type { ProcessRunner, SpawnedProcess } from "./process.js";
import { createBwrapSession } from "./session.js";

function stringStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (text) controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function createFakeRunner(result: { exitCode?: number; stdout?: string; stderr?: string } = {}) {
  const calls: string[][] = [];
  const runner: ProcessRunner = {
    spawn(argv): SpawnedProcess {
      calls.push([...argv]);
      return {
        pid: 1234,
        stdout: stringStream(result.stdout ?? ""),
        stderr: stringStream(result.stderr ?? ""),
        wait: async () => ({ exitCode: result.exitCode ?? 0 }),
        kill: async () => {},
      };
    },
  };
  return { runner, calls };
}

async function makeSession(result?: { exitCode?: number; stdout?: string; stderr?: string }) {
  const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-session-"));
  const workspaceDir = path.join(appRoot, ".eve", "sandbox-cache", "bwrap", "sessions", "s1");
  await mkdir(workspaceDir, { recursive: true });
  const { runner, calls } = createFakeRunner(result);
  const session = createBwrapSession({
    id: "s1",
    workspaceDir,
    appRoot,
    runner,
    options: resolveBwrapSandboxOptions({ env: { FACTORY: "yes" } }),
  });
  return { session, calls, workspaceDir, appRoot };
}

describe("run and spawn", () => {
  test("run collects streams and the exit code without throwing on failure", async () => {
    const { session } = await makeSession({ exitCode: 3, stdout: "so", stderr: "se" });
    const result = await session.run({ command: "boom" });
    expect(result).toEqual({ exitCode: 3, stdout: "so", stderr: "se" });
  });

  test("spawn builds a hardened bwrap argv: clearenv, hidden cache root, workspace bind", async () => {
    const { session, calls, workspaceDir, appRoot } = await makeSession();
    await session.spawn({ command: "echo hi", env: { CALL: "1" } });
    const argv = calls[0]!;
    expect(argv[0]).toBe("bwrap");
    expect(argv).toContain("--clearenv");
    const cacheRoot = path.join(appRoot, ".eve", "sandbox-cache", "bwrap");
    // second --tmpfs: the first is /tmp, the next hides the sandbox cache root
    const secondTmpfs = argv.indexOf("--tmpfs", argv.indexOf("--tmpfs") + 1);
    expect(argv.slice(secondTmpfs, secondTmpfs + 2)).toEqual(["--tmpfs", cacheRoot]);
    expect(argv).toContain(workspaceDir);
    expect(argv.slice(-3)).toEqual(["bash", "-lc", "echo hi"]);
    // env precedence: defaults < factory < call
    const setenv = argv.join(" ");
    expect(setenv).toContain("--setenv FACTORY yes");
    expect(setenv).toContain("--setenv CALL 1");
    expect(setenv).toContain("--setenv HOME /workspace");
    // the host process env must never be forwarded
    expect(setenv).not.toContain("OPENAI");
  });

  test("workingDirectory resolves against /workspace", async () => {
    const { session, calls } = await makeSession();
    await session.spawn({ command: "true", workingDirectory: "sub/dir" });
    const argv = calls[0]!;
    expect(argv.slice(argv.indexOf("--chdir"), argv.indexOf("--chdir") + 2)).toEqual(["--chdir", "/workspace/sub/dir"]);
  });
});

describe("network policy", () => {
  test("deny-all option and setNetworkPolicy toggle --unshare-net per call", async () => {
    const { session, calls } = await makeSession();
    await session.spawn({ command: "true" });
    expect(calls[0]).not.toContain("--unshare-net");
    await session.setNetworkPolicy("deny-all");
    await session.spawn({ command: "true" });
    expect(calls[1]).toContain("--unshare-net");
    await session.setNetworkPolicy("allow-all");
    await session.spawn({ command: "true" });
    expect(calls[2]).not.toContain("--unshare-net");
  });

  test("granular policies are rejected", async () => {
    const { session } = await makeSession();
    await expect(session.setNetworkPolicy({ allow: ["github.com"] })).rejects.toThrow(/allow-all.*deny-all/);
  });
});

describe("file I/O", () => {
  test("text roundtrip with nested directories and line slicing", async () => {
    const { session } = await makeSession();
    await session.writeTextFile({ path: "notes/deep/a.txt", content: "l1\nl2\nl3" });
    expect(await session.readTextFile({ path: "notes/deep/a.txt" })).toBe("l1\nl2\nl3");
    expect(await session.readTextFile({ path: "notes/deep/a.txt", startLine: 2, endLine: 2 })).toBe("l2");
    expect(await session.readTextFile({ path: "notes/deep/a.txt", startLine: 2, endLine: 99 })).toBe("l2\nl3");
  });

  test("missing files resolve null across all readers", async () => {
    const { session } = await makeSession();
    expect(await session.readTextFile({ path: "nope.txt" })).toBeNull();
    expect(await session.readBinaryFile({ path: "nope.txt" })).toBeNull();
    expect(await session.readFile({ path: "nope.txt" })).toBeNull();
  });

  test("binary and stream writes land in the workspace", async () => {
    const { session, workspaceDir } = await makeSession();
    await session.writeBinaryFile({ path: "bin.dat", content: new Uint8Array([1, 2, 3]) });
    expect([...(await session.readBinaryFile({ path: "bin.dat" }))!]).toEqual([1, 2, 3]);
    await session.writeFile({ path: "stream.txt", content: stringStream("streamed") });
    expect(await readFile(path.join(workspaceDir, "stream.txt"), "utf8")).toBe("streamed");
  });

  test("writes and removes outside the workspace are refused", async () => {
    const { session } = await makeSession();
    await expect(session.writeTextFile({ path: "/etc/evil", content: "x" })).rejects.toThrow(/workspace/);
    await expect(session.writeTextFile({ path: "a/../../escape.txt", content: "x" })).rejects.toThrow(/workspace/);
    await expect(session.removePath({ path: "/etc/hosts" })).rejects.toThrow(/workspace/);
  });

  test("removePath honors force and recursive", async () => {
    const { session, workspaceDir } = await makeSession();
    await session.writeTextFile({ path: "dir/inner.txt", content: "x" });
    await session.removePath({ path: "dir", recursive: true });
    expect(existsSync(path.join(workspaceDir, "dir"))).toBe(false);
    await expect(session.removePath({ path: "gone.txt" })).rejects.toThrow();
    await session.removePath({ path: "gone.txt", force: true });
  });

  test("reads of host paths outside the workspace pass through", async () => {
    const { session, appRoot } = await makeSession();
    await writeFile(path.join(appRoot, "host.txt"), "host-visible");
    expect(await session.readTextFile({ path: path.join(appRoot, "host.txt") })).toBe("host-visible");
  });

  test("resolvePath anchors to /workspace and id is stable", async () => {
    const { session } = await makeSession();
    expect(session.resolvePath("a.txt")).toBe("/workspace/a.txt");
    expect(session.resolvePath("/abs")).toBe("/abs");
    expect(session.id).toBe("s1");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @eveland/sandbox-bwrap test`
Expected: FAIL — `./session.js` not found.

- [ ] **Step 3: Implement the session**

`packages/sandbox-bwrap/src/session.ts`:

```ts
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import type { SandboxNetworkPolicy, SandboxSession } from "eve/sandbox";
import { buildBwrapExecArgs, DEFAULT_SANDBOX_PATH } from "./args.js";
import type { ResolvedBwrapSandboxOptions } from "./options.js";
import { isWithinWorkspace, resolveBwrapCacheRoot, resolveWorkspacePath, toHostPath, WORKSPACE_ROOT } from "./paths.js";
import type { ProcessRunner } from "./process.js";

export interface CreateBwrapSessionInput {
  readonly id: string;
  readonly workspaceDir: string;
  readonly appRoot: string;
  readonly runner: ProcessRunner;
  readonly options: ResolvedBwrapSandboxOptions;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function decodeText(bytes: Buffer, encoding: string): string {
  if (encoding === "utf-8" || encoding === "utf8") {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  return bytes.toString(encoding as BufferEncoding);
}

function sliceLines(text: string, startLine?: number, endLine?: number): string {
  if (startLine === undefined && endLine === undefined) return text;
  const lines = text.split("\n");
  return lines.slice((startLine ?? 1) - 1, endLine ?? lines.length).join("\n");
}

export function createBwrapSession(input: CreateBwrapSessionInput): SandboxSession {
  const { id, workspaceDir, appRoot, runner, options } = input;
  let networkPolicy: "allow-all" | "deny-all" = options.networkPolicy;

  const host = (path: string) => toHostPath(path, workspaceDir);

  function writableHostPath(path: string, operation: string): string {
    const hostPath = host(path);
    if (!isWithinWorkspace(hostPath, workspaceDir)) {
      throw new Error(`bwrap sandbox: refusing to ${operation} outside ${WORKSPACE_ROOT}: ${path}`);
    }
    return hostPath;
  }

  async function spawnProcess(spawnOptions: { command: string; workingDirectory?: string; env?: Record<string, string>; abortSignal?: AbortSignal }) {
    const env = {
      PATH: DEFAULT_SANDBOX_PATH,
      HOME: WORKSPACE_ROOT,
      LANG: "C.UTF-8",
      ...options.env,
      ...spawnOptions.env,
    };
    const hidePaths = [resolveBwrapCacheRoot(appRoot), ...options.hidePaths].filter((path) => existsSync(path));
    const argv = buildBwrapExecArgs({
      bwrapPath: options.bwrapPath,
      workspaceDir,
      hidePaths,
      shareNetwork: networkPolicy === "allow-all",
      env,
      chdir: resolveWorkspacePath(spawnOptions.workingDirectory ?? WORKSPACE_ROOT),
      command: spawnOptions.command,
    });
    return runner.spawn(argv, { abortSignal: spawnOptions.abortSignal });
  }

  return {
    id,
    resolvePath: resolveWorkspacePath,

    async spawn(spawnOptions) {
      return await spawnProcess(spawnOptions);
    },

    async run(runOptions) {
      const proc = await spawnProcess(runOptions);
      const [stdout, stderr] = await Promise.all([collectStream(proc.stdout), collectStream(proc.stderr)]);
      const { exitCode } = await proc.wait();
      return { exitCode, stdout, stderr };
    },

    async setNetworkPolicy(policy: SandboxNetworkPolicy) {
      if (policy !== "allow-all" && policy !== "deny-all") {
        throw new Error('bwrap backend supports only the "allow-all" and "deny-all" network policies');
      }
      networkPolicy = policy;
    },

    async readFile({ path }) {
      const hostPath = host(path);
      if (!existsSync(hostPath)) return null;
      return Readable.toWeb(createReadStream(hostPath)) as unknown as ReadableStream<Uint8Array>;
    },

    async readBinaryFile({ path }) {
      try {
        const bytes = await readFile(host(path));
        return new Uint8Array(bytes);
      } catch (error) {
        if (isMissingFileError(error)) return null;
        throw error;
      }
    },

    async readTextFile({ path, encoding, startLine, endLine }) {
      try {
        const bytes = await readFile(host(path));
        return sliceLines(decodeText(bytes, encoding ?? "utf-8"), startLine, endLine);
      } catch (error) {
        if (isMissingFileError(error)) return null;
        throw error;
      }
    },

    async writeFile({ path, content }) {
      const hostPath = writableHostPath(path, "write");
      await mkdir(dirname(hostPath), { recursive: true });
      await pipeline(Readable.fromWeb(content as never), createWriteStream(hostPath));
    },

    async writeBinaryFile({ path, content }) {
      const hostPath = writableHostPath(path, "write");
      await mkdir(dirname(hostPath), { recursive: true });
      await writeFile(hostPath, content);
    },

    async writeTextFile({ path, content, encoding }) {
      const hostPath = writableHostPath(path, "write");
      await mkdir(dirname(hostPath), { recursive: true });
      const enc = encoding === undefined || encoding === "utf-8" ? "utf8" : encoding;
      await writeFile(hostPath, Buffer.from(content, enc as BufferEncoding));
    },

    async removePath({ path, force, recursive }) {
      const hostPath = writableHostPath(path, "remove");
      if (force !== true && !existsSync(hostPath)) {
        throw new Error(`bwrap sandbox: path does not exist: ${path}`);
      }
      await rm(hostPath, { force: force === true, recursive: recursive === true });
    },
  };
}
```

Implementation notes for this step:
- The `SandboxSession` interface types come from `eve/sandbox`; if TypeScript complains that our object literal's method signatures don't match the AI SDK's `PromiseLike` shapes, prefer adjusting our signatures over casting. A final `satisfies SandboxSession` or the annotated return type must hold without `as SandboxSession`.
- `Readable.fromWeb(content as never)`: Node's web-stream types and the DOM lib disagree; this cast is confined to the boundary.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @eveland/sandbox-bwrap test && pnpm --filter @eveland/sandbox-bwrap typecheck`
Expected: all PASS, typecheck clean (this is also the type-level proof our session satisfies eve's public interface).

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-bwrap/src
git commit -m "feat(sandbox-bwrap): full SandboxSession over a bwrap-backed workspace"
```

---

### Task 4: The backend (prewarm/create) and public API

**Files:**
- Create: `packages/sandbox-bwrap/src/backend.ts`
- Create: `packages/sandbox-bwrap/src/index.ts`
- Test: `packages/sandbox-bwrap/src/backend.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3 (`resolveBwrapSandboxOptions`, `createBwrapOptionsHash`, path helpers, `ProcessRunner`, `createNodeProcessRunner`, `isBwrapAvailable`, `createBwrapSession`).
- Produces (the public package surface):
  - `const BWRAP_BACKEND_NAME = "bwrap"`
  - `interface CreateBwrapSandboxBackendInput { createOptions?: BwrapSandboxCreateOptions; runner?: ProcessRunner }`
  - `createBwrapSandboxBackend(input?: CreateBwrapSandboxBackendInput): SandboxBackend`
  - `bwrap(options?: BwrapSandboxCreateOptions): SandboxBackend` (in `index.ts`)
  - Re-exports: `isBwrapAvailable`, `BwrapSandboxCreateOptions`, `BwrapNetworkPolicy`

- [ ] **Step 1: Write failing tests**

`packages/sandbox-bwrap/src/backend.test.ts`:

```ts
import { existsSync } from "node:fs";
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { SandboxTemplateNotProvisionedError } from "eve/sandbox";
import { BWRAP_BACKEND_NAME, createBwrapSandboxBackend } from "./backend.js";
import { bwrap, isBwrapAvailable } from "./index.js";
import type { ProcessRunner } from "./process.js";

const fakeRunner: ProcessRunner = {
  spawn() {
    const empty = () => new ReadableStream<Uint8Array>({ start: (c) => c.close() });
    return { stdout: empty(), stderr: empty(), wait: async () => ({ exitCode: 0 }), kill: async () => {} };
  },
};

async function makeBackend() {
  const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-backend-"));
  const backend = createBwrapSandboxBackend({ runner: fakeRunner });
  return { appRoot, backend, runtimeContext: { appRoot } };
}

describe("prewarm", () => {
  test("captures a template once and reuses it after", async () => {
    const { backend, runtimeContext, appRoot } = await makeBackend();
    const first = await backend.prewarm({
      templateKey: "tpl-1",
      runtimeContext,
      seedFiles: [
        { path: "seed.txt", content: "seeded" },
        { path: "bin/seed.dat", content: Buffer.from([7]) },
      ],
      bootstrap: async ({ use }) => {
        const session = await use();
        await session.writeTextFile({ path: "boot.txt", content: "booted" });
      },
    });
    expect(first).toEqual({ reused: false });

    const second = await backend.prewarm({ templateKey: "tpl-1", runtimeContext, seedFiles: [] });
    expect(second).toEqual({ reused: true });

    const templatesDir = path.join(appRoot, ".eve", "sandbox-cache", "bwrap", "templates");
    const entries = await readdir(templatesDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toContain(".staging");
  });
});

describe("create", () => {
  test("clones the template into a persistent per-session workspace", async () => {
    const { backend, runtimeContext } = await makeBackend();
    await backend.prewarm({
      templateKey: "tpl-1",
      runtimeContext,
      seedFiles: [{ path: "seed.txt", content: "seeded" }],
    });

    const handle = await backend.create({ templateKey: "tpl-1", sessionKey: "sess-1", runtimeContext });
    expect(await handle.session.readTextFile({ path: "seed.txt" })).toBe("seeded");
    expect(await handle.useSessionFn()).toBe(handle.session);
    expect(await handle.captureState()).toEqual({ backendName: "bwrap", metadata: {}, sessionKey: "sess-1" });

    await handle.session.writeTextFile({ path: "state.txt", content: "persisted" });
    await handle.dispose();

    const again = await backend.create({ templateKey: "tpl-1", sessionKey: "sess-1", runtimeContext });
    expect(await again.session.readTextFile({ path: "state.txt" })).toBe("persisted");

    const other = await backend.create({ templateKey: "tpl-1", sessionKey: "sess-2", runtimeContext });
    expect(await other.session.readTextFile({ path: "state.txt" })).toBeNull();
  });

  test("null templateKey creates an empty workspace", async () => {
    const { backend, runtimeContext } = await makeBackend();
    const handle = await backend.create({ templateKey: null, sessionKey: "fresh", runtimeContext });
    const result = await handle.session.readTextFile({ path: "anything.txt" });
    expect(result).toBeNull();
  });

  test("missing template throws the typed eve error", async () => {
    const { backend, runtimeContext } = await makeBackend();
    await expect(backend.create({ templateKey: "never-prewarmed", sessionKey: "s", runtimeContext })).rejects.toSatisfy(
      (error: unknown) => SandboxTemplateNotProvisionedError.is(error),
    );
  });

  test("options changes re-key templates but not sessions", async () => {
    const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-backend-"));
    const runtimeContext = { appRoot };
    const a = createBwrapSandboxBackend({ runner: fakeRunner, createOptions: { env: { A: "1" } } });
    const b = createBwrapSandboxBackend({ runner: fakeRunner, createOptions: { env: { A: "2" } } });
    await a.prewarm({ templateKey: "tpl", runtimeContext, seedFiles: [] });
    // same templateKey under different options is a distinct template
    await expect(b.create({ templateKey: "tpl", sessionKey: "s", runtimeContext })).rejects.toSatisfy(
      (error: unknown) => SandboxTemplateNotProvisionedError.is(error),
    );
  });
});

describe("public API", () => {
  test("exposes the frozen backend name and factory", () => {
    expect(BWRAP_BACKEND_NAME).toBe("bwrap");
    expect(bwrap().name).toBe("bwrap");
    expect(typeof isBwrapAvailable).toBe("function");
  });
});
```

Note: `bwrap()` uses the real runner; constructing it must NOT probe for bwrap (probe happens lazily on first prewarm/create), or this test would fail on macOS.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @eveland/sandbox-bwrap test`
Expected: FAIL — `./backend.js` / `./index.js` not found.

- [ ] **Step 3: Implement the backend**

`packages/sandbox-bwrap/src/backend.ts`:

```ts
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { SandboxBackend, SandboxSeedFile, SandboxSession } from "eve/sandbox";
import { SandboxTemplateNotProvisionedError } from "eve/sandbox";
import type { BwrapSandboxCreateOptions } from "./options.js";
import { createBwrapOptionsHash, resolveBwrapSandboxOptions } from "./options.js";
import { resolveSessionPath, resolveTemplatePath } from "./paths.js";
import type { ProcessRunner } from "./process.js";
import { createNodeProcessRunner, isBwrapAvailable } from "./process.js";
import { createBwrapSession } from "./session.js";

/**
 * Stable backend name. Participates in eve's template/session cache-key
 * derivation and persisted reconnect state — never change it.
 */
export const BWRAP_BACKEND_NAME = "bwrap";

export interface CreateBwrapSandboxBackendInput {
  readonly createOptions?: BwrapSandboxCreateOptions;
  /** Injectable process launcher so backend logic is testable without bwrap. */
  readonly runner?: ProcessRunner;
}

async function copyDirectoryAtomically(sourcePath: string, targetPath: string): Promise<void> {
  const tmpPath = `${targetPath}.${randomUUID()}.tmp`;
  await mkdir(dirname(targetPath), { recursive: true });
  try {
    await cp(sourcePath, tmpPath, { recursive: true });
    await rename(tmpPath, targetPath);
  } catch (error) {
    await rm(tmpPath, { force: true, recursive: true }).catch(() => {});
    // A concurrent writer winning the rename race is success, not failure.
    if (existsSync(targetPath)) return;
    throw error;
  }
}

export function createBwrapSandboxBackend(input: CreateBwrapSandboxBackendInput = {}): SandboxBackend {
  const options = resolveBwrapSandboxOptions(input.createOptions);
  const optionsHash = createBwrapOptionsHash(options);
  const runner = input.runner ?? createNodeProcessRunner();
  // Probe only when running against the real bwrap; injected runners skip it.
  const shouldProbe = input.runner === undefined;
  let probed = false;

  function assertBwrapAvailable(): void {
    if (!shouldProbe || probed) return;
    if (!isBwrapAvailable(options.bwrapPath)) {
      throw new Error(
        `bubblewrap is not available (tried "${options.bwrapPath} --version"). ` +
          "Install it with your distro package manager (Ubuntu/Debian: apt-get install bubblewrap), " +
          "or select a different backend outside Linux, e.g. " +
          "backend: () => (isBwrapAvailable() ? bwrap() : defaultBackend()).",
      );
    }
    probed = true;
  }

  function openSession(id: string, workspaceDir: string, appRoot: string): SandboxSession {
    return createBwrapSession({ id, workspaceDir, appRoot, runner, options });
  }

  async function writeSeedFiles(session: SandboxSession, seedFiles: ReadonlyArray<SandboxSeedFile>): Promise<void> {
    for (const seed of seedFiles) {
      if (typeof seed.content === "string") {
        await session.writeTextFile({ path: seed.path, content: seed.content });
      } else {
        await session.writeBinaryFile({ path: seed.path, content: seed.content });
      }
    }
  }

  return {
    name: BWRAP_BACKEND_NAME,

    async prewarm({ templateKey, bootstrap, seedFiles, log, runtimeContext }) {
      assertBwrapAvailable();
      const templatePath = resolveTemplatePath(runtimeContext.appRoot, templateKey, optionsHash);
      if (existsSync(templatePath)) return { reused: true };

      log?.(`bwrap: capturing template for ${templateKey}`);
      const stagingPath = `${templatePath}.staging-${randomUUID()}`;
      await mkdir(stagingPath, { recursive: true });
      try {
        const session = openSession(templateKey, stagingPath, runtimeContext.appRoot);
        if (bootstrap) await bootstrap({ use: async () => session });
        await writeSeedFiles(session, seedFiles);
        await rename(stagingPath, templatePath);
      } catch (error) {
        await rm(stagingPath, { force: true, recursive: true }).catch(() => {});
        // A concurrent prewarm winning the race is reuse, not failure.
        if (existsSync(templatePath)) return { reused: true };
        throw error;
      }
      return { reused: false };
    },

    async create({ templateKey, sessionKey, runtimeContext }) {
      assertBwrapAvailable();
      const sessionPath = resolveSessionPath(runtimeContext.appRoot, sessionKey);
      if (!existsSync(sessionPath)) {
        if (templateKey === null) {
          await mkdir(sessionPath, { recursive: true });
        } else {
          const templatePath = resolveTemplatePath(runtimeContext.appRoot, templateKey, optionsHash);
          if (!existsSync(templatePath)) {
            throw new SandboxTemplateNotProvisionedError({ backendName: BWRAP_BACKEND_NAME, templateKey });
          }
          await copyDirectoryAtomically(templatePath, sessionPath);
        }
      }
      const session = openSession(sessionKey, sessionPath, runtimeContext.appRoot);
      return {
        session,
        useSessionFn: async () => session,
        async captureState() {
          return { backendName: BWRAP_BACKEND_NAME, metadata: {}, sessionKey };
        },
        // The workspace directory persists on disk; sandboxed processes die
        // with the agent (--die-with-parent), so there is nothing to release.
        async dispose() {},
      };
    },
  };
}
```

`packages/sandbox-bwrap/src/index.ts`:

```ts
import type { SandboxBackend } from "eve/sandbox";
import { createBwrapSandboxBackend } from "./backend.js";
import type { BwrapSandboxCreateOptions } from "./options.js";

export { BWRAP_BACKEND_NAME, createBwrapSandboxBackend, type CreateBwrapSandboxBackendInput } from "./backend.js";
export type { BwrapNetworkPolicy, BwrapSandboxCreateOptions } from "./options.js";
export { isBwrapAvailable } from "./process.js";
export type { ProcessRunner, SpawnedProcess } from "./process.js";

/**
 * Creates the bubblewrap sandbox backend for `defineSandbox({ backend })`.
 *
 * ```ts
 * // agent/sandbox.ts
 * import { defineSandbox, defaultBackend } from "eve/sandbox";
 * import { bwrap, isBwrapAvailable } from "@eveland/sandbox-bwrap";
 *
 * export default defineSandbox({
 *   backend: () => (isBwrapAvailable() ? bwrap() : defaultBackend()),
 * });
 * ```
 */
export function bwrap(options?: BwrapSandboxCreateOptions): SandboxBackend {
  return createBwrapSandboxBackend({ createOptions: options });
}
```

- [ ] **Step 4: Run tests, typecheck, and build**

Run: `pnpm --filter @eveland/sandbox-bwrap test && pnpm --filter @eveland/sandbox-bwrap typecheck && pnpm --filter @eveland/sandbox-bwrap build`
Expected: all PASS; `packages/sandbox-bwrap/dist/index.js` and `dist/index.d.ts` exist (dist is gitignored).

- [ ] **Step 5: Run the whole workspace suite**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: PASS — no regressions elsewhere.

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox-bwrap/src
git commit -m "feat(sandbox-bwrap): SandboxBackend with directory templates and public bwrap() factory"
```

---

### Task 5: Real-bwrap contract test in the Lima VM

**Files:**
- Create: `packages/sandbox-bwrap/src/integration/bwrap-backend-smoke.ts`
- Modify: `infra/integration/run.sh`

**Interfaces:**
- Consumes: the full public backend from Task 4 (imported via relative paths, run with tsx — no build needed).
- Produces: `bash infra/integration/run.sh` runs BOTH smokes; the new one prints `BWRAP SMOKE OK`.

This task is the plan's risk gate: it is the first time bwrap runs as the unprivileged `eveland-app` user under `NoNewPrivileges=yes` + `ProtectSystem=strict` (Plan 1 only ran bwrap as root during builds). If bwrap fails there with `Creating new namespace failed: Operation not permitted`, debug — do not weaken the unit properties to pass:
- `limactl shell eveland-test -- sysctl kernel.apparmor_restrict_unprivileged_userns` (expect `1` on Ubuntu 24.04 — that's fine WITH the apt bwrap profile)
- `limactl shell eveland-test -- ls /etc/apparmor.d/bwrap` (must exist; installed by the bubblewrap deb)
- `limactl shell eveland-test -- aa-status | grep bwrap`
Report findings in the task summary if the constraint combination fails; that changes the deployment story and must surface, not be papered over.

- [ ] **Step 1: Write the smoke script**

`packages/sandbox-bwrap/src/integration/bwrap-backend-smoke.ts`:

```ts
// Real-bwrap backend contract test. Requires Linux + bubblewrap + bash — run it
// inside the Lima VM via infra/integration/run.sh, not on a dev laptop.
// It is intentionally run as an unprivileged user under systemd hardening
// (NoNewPrivileges, ProtectSystem=strict) to mirror a deployed eve agent.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { SandboxTemplateNotProvisionedError } from "eve/sandbox";
import { createBwrapSandboxBackend } from "../backend.js";
import { isBwrapAvailable } from "../process.js";

const SECRET = "smoke-secret-do-not-leak";

async function main(): Promise<void> {
  assert.equal(isBwrapAvailable(), true, "bwrap must be installed in the VM");
  process.env.SMOKE_SECRET = SECRET;

  const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-smoke-"));
  try {
    const backend = createBwrapSandboxBackend();
    const runtimeContext = { appRoot };

    // prewarm: bootstrap runs inside bwrap; seeds land in the template
    const first = await backend.prewarm({
      templateKey: "smoke-template",
      runtimeContext,
      seedFiles: [{ path: "seeded.txt", content: "from-seed" }],
      bootstrap: async ({ use }) => {
        const session = await use();
        const result = await session.run({ command: "printf bootstrapped > boot.txt" });
        assert.equal(result.exitCode, 0, `bootstrap command failed: ${result.stderr}`);
      },
    });
    assert.equal(first.reused, false, "first prewarm must capture fresh state");
    const second = await backend.prewarm({ templateKey: "smoke-template", runtimeContext, seedFiles: [] });
    assert.equal(second.reused, true, "second prewarm must reuse the template");

    // unknown template → typed error
    await assert.rejects(
      backend.create({ templateKey: "never-prewarmed", sessionKey: "sx", runtimeContext }),
      (error: unknown) => SandboxTemplateNotProvisionedError.is(error),
    );

    // create: template state visible in the session workspace
    const handle = await backend.create({ templateKey: "smoke-template", sessionKey: "sess-1", runtimeContext });
    const session = handle.session;
    assert.equal(await session.readTextFile({ path: "seeded.txt" }), "from-seed");
    assert.equal(await session.readTextFile({ path: "boot.txt" }), "bootstrapped");

    // cwd is /workspace
    const pwd = await session.run({ command: "pwd" });
    assert.equal(pwd.stdout.trim(), "/workspace");

    // rootfs is read-only outside /workspace
    const readOnly = await session.run({ command: "touch /usr/smoke-marker" });
    assert.notEqual(readOnly.exitCode, 0, "writing outside /workspace must fail");

    // host process env must NOT leak into the sandbox
    const env = await session.run({ command: "env" });
    assert.ok(!env.stdout.includes(SECRET), "host process env leaked into the sandbox");
    assert.ok(env.stdout.includes("HOME=/workspace"), "sandbox HOME must be /workspace");

    // the sandbox cache root (other sessions + templates) is hidden
    const cacheLs = await session.run({ command: `ls -A ${appRoot}/.eve/sandbox-cache/bwrap` });
    assert.equal(cacheLs.stdout.trim(), "", "sandbox cache root must be hidden by tmpfs");

    // network: allow-all sees a non-loopback interface; deny-all does not.
    // /sys/class/net shows the namespace that mounted sysfs, so ask the kernel
    // via netlink (os.networkInterfaces) instead.
    const ifaceCommand = `node -e "console.log(Object.keys(require('node:os').networkInterfaces()).join(' '))"`;
    const allowNet = await session.run({ command: ifaceCommand });
    assert.equal(allowNet.exitCode, 0, `iface probe failed: ${allowNet.stderr}`);
    assert.ok(
      allowNet.stdout.trim().split(/\s+/).some((name) => name !== "" && name !== "lo"),
      "allow-all must see a host network interface",
    );
    await session.setNetworkPolicy("deny-all");
    const denyNet = await session.run({ command: ifaceCommand });
    assert.equal(
      denyNet.stdout.trim().split(/\s+/).filter((name) => name !== "" && name !== "lo").length,
      0,
      "deny-all must leave at most loopback",
    );
    await session.setNetworkPolicy("allow-all");

    // spawn + kill terminates the sandboxed tree promptly
    const proc = await session.spawn({ command: "sleep 300" });
    await sleep(200);
    await proc.kill();
    const settled = await Promise.race([
      Promise.resolve(proc.wait()).then(
        () => "settled",
        () => "settled",
      ),
      sleep(5000).then(() => "timeout"),
    ]);
    assert.equal(settled, "settled", "killed spawn must settle wait() promptly");

    // persistence across reconnect; isolation between sessions
    await session.writeTextFile({ path: "notes/hello.txt", content: "persisted" });
    await handle.dispose();
    const again = await backend.create({ templateKey: "smoke-template", sessionKey: "sess-1", runtimeContext });
    assert.equal(await again.session.readTextFile({ path: "notes/hello.txt" }), "persisted");
    const other = await backend.create({ templateKey: "smoke-template", sessionKey: "sess-2", runtimeContext });
    assert.equal(await other.session.readTextFile({ path: "notes/hello.txt" }), null);

    console.log("BWRAP SMOKE OK");
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Wire it into the integration runner**

Modify `infra/integration/run.sh` — replace the single `limactl shell` block with:

```bash
limactl shell "$VM" -- sudo bash -c "
  set -euo pipefail
  rsync -a --delete --exclude node_modules --exclude .eveland-data --exclude .next '$REPO_DIR/' /opt/eveland/
  cd /opt/eveland
  corepack pnpm install --frozen-lockfile
  EVELAND_RUNTIME=systemd EVELAND_BUILD_SANDBOX=bwrap EVELAND_DATA_DIR=/var/lib/eveland-data \
    corepack pnpm --filter @eveland/worker exec tsx src/integration/systemd-smoke.ts

  # Agent-exec sandbox contract test, run under the same constraints as a
  # deployed eve agent: unprivileged user, NoNewPrivileges, read-only system.
  install -d -o eveland-app -g eveland-app /var/lib/eveland-app
  systemd-run --wait --pipe --collect --service-type=exec \
    --property=User=eveland-app \
    --property=NoNewPrivileges=yes \
    --property=ProtectSystem=strict \
    --property=PrivateTmp=yes \
    --property=ReadWritePaths=/var/lib/eveland-app \
    --setenv=TMPDIR=/var/lib/eveland-app \
    bash -lc 'cd /opt/eveland/packages/sandbox-bwrap && ../../node_modules/.bin/tsx src/integration/bwrap-backend-smoke.ts'
"
```

Notes: `TMPDIR=/var/lib/eveland-app` puts the smoke's appRoot inside the unit's only writable path — the realistic on-disk layout. The rest of the script (VM start-or-reuse) is unchanged.

- [ ] **Step 3: Run the integration suite**

Run: `bash infra/integration/run.sh`
Expected: prints `SMOKE OK` (Plan 1's worker smoke) AND `BWRAP SMOKE OK`, exits 0. First run installs eve into the VM's pnpm store — slower is normal.

- [ ] **Step 4: Verify no leaked processes or units in the VM**

Run: `limactl shell eveland-test -- bash -c "systemctl list-units 'run-*' --no-legend | cat; pgrep -u eveland-app -l | cat"`
Expected: no lingering `run-*` transient units from the smoke, no leftover `sleep` processes owned by `eveland-app`.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-bwrap/src/integration infra/integration/run.sh
git commit -m "feat(sandbox-bwrap): Lima VM contract test under deployed-agent systemd constraints"
```

---

### Task 6: Documentation for developers and agents

The user explicitly required: after Plan 2 completes, update documentation so other developers/agents understand how this works. That means three audiences: eve project authors (how to use the backend), eveland operators (what changed on the deploy host), and future contributors/agents in this repo (where things live and why).

**Files:**
- Create: `packages/sandbox-bwrap/README.md`
- Modify: `docs/deploy/linux.md` (three edits below)
- Modify: `README.md` (one bullet)

- [ ] **Step 1: Write the package README**

`packages/sandbox-bwrap/README.md`:

````markdown
# @eveland/sandbox-bwrap

A [bubblewrap](https://github.com/containers/bubblewrap)-based `SandboxBackend` for
[eve](https://www.npmjs.com/package/eve) agents. It gives agent-executed code a real
Linux sandbox — actual binaries, isolated filesystem, coarse network control — without
requiring a Docker daemon or KVM.

## Why

eve's built-in backend chain is Vercel → Docker → microsandbox → just-bash. On a
self-hosted Linux box without a Docker daemon or KVM (for example an eveland systemd
deployment host), that chain bottoms out at `justbash`: a pure-JS interpreter with a
virtual filesystem that cannot run real binaries. This backend fills that gap with
bubblewrap, which needs nothing but the `bwrap` binary and unprivileged user
namespaces.

## Usage

```ts
// agent/sandbox.ts
import { defineSandbox, defaultBackend } from "eve/sandbox";
import { bwrap, isBwrapAvailable } from "@eveland/sandbox-bwrap";

export default defineSandbox({
  // bwrap on the Linux deploy host; eve's default chain everywhere else (dev laptops).
  backend: () => (isBwrapAvailable() ? bwrap() : defaultBackend()),
});
```

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `env` | `{}` | Environment variables set for every sandboxed command. |
| `networkPolicy` | `"allow-all"` | `"allow-all"` shares the host network; `"deny-all"` runs each command with no network (`--unshare-net`). `setNetworkPolicy` can switch between the two at run time; granular domain policies are rejected (use the Vercel backend for those). |
| `hidePaths` | `[]` | Extra host paths hidden from the sandbox (each covered by an empty tmpfs). |
| `bwrapPath` | `"bwrap"` | bwrap executable to invoke. |

## How it works

- **prewarm** (build time): runs the authored `bootstrap` inside bwrap against a
  staging directory, writes seed files, then atomically renames it into
  `<appRoot>/.eve/sandbox-cache/bwrap/templates/<hash>`. Idempotent per template key +
  options hash.
- **create** (runtime): clones the template into
  `<appRoot>/.eve/sandbox-cache/bwrap/sessions/<hash>` on first use. The directory IS
  the durable session state: it persists across reconnects and process restarts.
- **run/spawn**: every command is one transient bwrap invocation —
  read-only host rootfs, the session directory bound read-write at `/workspace`,
  tmpfs `/tmp`, PID/IPC/UTS namespaces unshared, `--die-with-parent`.
- **File I/O** (`readTextFile`, `writeFile`, …): host-side operations on the session
  directory; no subprocess. Writes outside `/workspace` are refused.

## Security boundary

- The host process environment is **never** forwarded: every invocation uses
  `--clearenv` and rebuilds the environment from `PATH`, `HOME=/workspace`, `LANG`,
  plus your configured `env`. Deployment secrets in the agent's `process.env` stay
  out of sandboxed code.
- The sandbox cache root (all other sessions and templates of the app) is hidden
  behind a tmpfs, so sandboxed code cannot read sibling session state.
- The rest of the host filesystem is *visible read-only* to sandboxed code, and the
  sandbox shares the host kernel. This is protection against mistakes and prompt
  injection — not multi-tenant isolation. If untrusted tenants or code that routinely
  handles customer credentials must run here, move to VM-level isolation
  (Firecracker/microsandbox) instead of hardening this backend further.
- Resource limits are inherited from whatever cgroup the agent runs in (on eveland's
  systemd runtime: the deployment unit's `MemoryMax`/`CPUQuota` cover sandbox
  children too). The backend sets no per-command limits itself.

## Requirements

- Linux with unprivileged user namespaces available to the calling process. On
  Ubuntu 23.10+ install bubblewrap **via apt** — the packaged AppArmor profile is
  what authorizes unprivileged userns; a hand-built bwrap will hit EPERM.
- `bash` and (for agents that need it) `node` on the host PATH — the sandbox reuses
  the host rootfs read-only.
- Works under systemd hardening (`NoNewPrivileges=yes`, `ProtectSystem=strict`):
  apt's bwrap is not setuid, so no privilege escalation is needed.

## Testing

- `pnpm --filter @eveland/sandbox-bwrap test` — unit tests, run anywhere (process
  execution is injectable; no bwrap needed).
- `bash infra/integration/run.sh` — full contract test against real bwrap inside the
  Lima VM, executed as an unprivileged user under deployed-agent systemd constraints.
  Prints `BWRAP SMOKE OK` on success.
````

- [ ] **Step 2: Update the Linux deploy docs**

Three edits to `docs/deploy/linux.md`:

Edit 1 — append a new section right after the "How a deployment runs" section:

````markdown
## Agent exec sandbox

Deployed eve agents get no Docker daemon and no KVM, so eve's default sandbox chain
degrades to the `just-bash` interpreter (no real binaries). Projects that need a real
exec sandbox opt in to the bubblewrap backend in their `agent/sandbox.ts`:

```ts
import { defineSandbox, defaultBackend } from "eve/sandbox";
import { bwrap, isBwrapAvailable } from "@eveland/sandbox-bwrap";

export default defineSandbox({
  backend: () => (isBwrapAvailable() ? bwrap() : defaultBackend()),
});
```

The host prerequisites are already covered by this guide (`bubblewrap` from apt).
The backend works inside the deployment unit's hardening (`NoNewPrivileges`,
`ProtectSystem=strict`) because apt's bwrap uses unprivileged user namespaces, not
setuid. Sandboxed commands never see the deployment's environment variables
(secrets stay in the agent process), and sandbox workspaces live under the release
directory at `.eve/sandbox-cache/bwrap/`. See `packages/sandbox-bwrap/README.md`
for the full behavior and security boundary.
````

Edit 2 — in "Known limits (v1)", replace the line:

```markdown
- The eve sandbox backend inside deployed agents is addressed separately
  (`@eveland/sandbox-bwrap`, Plan 2).
```

with:

```markdown
- Deployed agents use eve's default sandbox chain unless the project opts in to
  `@eveland/sandbox-bwrap` (see "Agent exec sandbox" above).
```

Edit 3 — in the "Verifying the setup" section, after the paragraph describing what the smoke test does, add:

```markdown
The same script then runs the `@eveland/sandbox-bwrap` contract test as the
unprivileged `eveland-app` user under deployed-agent systemd constraints
(`NoNewPrivileges`, `ProtectSystem=strict`). A fully successful run prints both
`SMOKE OK` and `BWRAP SMOKE OK`.
```

- [ ] **Step 3: Add the package to the root README**

In `README.md`, in the "Current MVP Slice" list, add after the `packages/shared` bullet:

```markdown
- `packages/sandbox-bwrap`: bubblewrap-based eve `SandboxBackend` so agents deployed on the systemd runtime get a real exec sandbox without Docker/KVM (see `packages/sandbox-bwrap/README.md`).
```

- [ ] **Step 4: Verify docs consistency**

Re-read the three changed docs end to end. Checklist: every env/option name matches the code (`networkPolicy`, `hidePaths`, `bwrapPath`); the cache path in prose matches `resolveBwrapCacheRoot` (`.eve/sandbox-cache/bwrap`); both smoke markers (`SMOKE OK`, `BWRAP SMOKE OK`) are mentioned; no doc still claims the agent sandbox is unaddressed.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-bwrap/README.md docs/deploy/linux.md README.md
git commit -m "docs(sandbox-bwrap): usage, security boundary, and deploy-host integration"
```

---

## Self-Review Notes

- Spec coverage: prewarm/create/session/network-parity/persistence (agreed Plan 2 scope) → Tasks 1–4; VM verification under real deployment constraints → Task 5; user-mandated documentation → Task 6.
- The public-surface bet: we implement eve's full `SandboxSession` because `buildSandboxSession` is not exported from `eve/sandbox`. The typecheck in Task 3/4 against eve's published types is the contract proof.
- Known deferred items (do NOT expand scope mid-plan): template/session pruning, per-command resource limits, granular network policies, publishing the package to npm.
