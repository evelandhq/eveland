# Platform-Injected Sandbox on eve 0.22 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** eveland deploys any imported eve project onto the systemd runtime with a working bubblewrap exec sandbox, without the project ever declaring one — and a deploy fails loudly when the sandbox does not work on that host.

**Architecture:** Three moves. (1) `@evelandhq/sandbox-bwrap` upgrades to eve 0.22.x: `dispose()` → `shutdown()` with live-process tracking, and the sandbox cache moves out of the release directory to a stable per-project path so a redeploy no longer discards durable `/workspace` state. (2) The worker's systemd `buildRelease` injects a generated `agent/sandbox.js` (plus one per subagent) into the release directory and vendors the built backend beside it, ignoring any authored sandbox module. (3) Because eve prewarms sandboxes lazily — verified: neither `eve build` nor `eve start` calls `prewarm`, and `/eve/v1/health` returns 200 with a completely broken backend — the build runs a sandbox self-check under the deployment's own systemd hardening, so a host that cannot run bwrap fails the deploy instead of failing the first user turn.

**Tech Stack:** TypeScript (strict, NodeNext, ESM), Node ≥24 builtins, eve `>=0.20.0 <0.23.0` (dev/peer), vitest ^4, execa (worker), bubblewrap, Lima VM `eveland-test`.

## Global Constraints

- **Follow eve's latest version. No back-compat branches for eve < 0.20.** (`>=0.20.0 <0.23.0`.) eve 0.x caret ranges pin the _minor_ — `^0.17.1` excludes 0.22, so peer/dev ranges must be written explicitly.
- Agent projects must never need to know a sandbox backend exists. The generated module is written into the **release directory**, never into the user's source tree.
- An authored sandbox (`agent/sandbox.ts` or `agent/sandbox/`) is **ignored and replaced**. This is a deliberate decision (2026-07-09) and it drops that module's `bootstrap()`, `onSession()`, and `agent/sandbox/workspace/` seed tree. Every override MUST emit a loud line into the build log.
- `@evelandhq/sandbox-bwrap` keeps **zero runtime dependencies** (Node builtins only). ESM, `.js` extensions on relative imports, strict NodeNext.
- Injection applies to the **systemd runtime only**. The docker adapter builds from the user's source tree via a generated Dockerfile and must not be touched.
- Security invariants from Plan 2 hold unchanged: every bwrap invocation carries `--clearenv`; tmpfs hides precede the `/workspace` bind; host-side writes/removes are realpath-contained.
- Tests: vitest, colocated `*.test.ts`, explicit imports. Unit tests must pass on macOS with no bwrap (execution stays behind the injectable `ProcessRunner`).
- Git hygiene: work only in the worktree `/Users/michael/work/eveland/.claude/worktrees/sandbox-inject-eve022` on branch `worktree-sandbox-inject-eve022`. Never touch the main checkout. Never use bare `git stash`.

## Verified facts this plan rests on (do not re-derive; do not contradict)

Established by direct experiment on 2026-07-09 against eve 0.22.1. Anything here that a task disproves is a finding — report it, do not silently work around it.

1. **eve 0.20.0 breaking change** (from eve's own CHANGELOG): "`SandboxBackendHandle` gains a required `shutdown()` and the unused `dispose()` is removed." Compiling today's `packages/sandbox-bwrap/src` against eve@0.22.1 produces exactly one error: `src/backend.ts(98,11): error TS2322: … Property 'shutdown' is missing`. Everything else — `SandboxSession`, `SandboxDefinition`, `public/definitions/sandbox-backend.d.ts` — is byte-identical between 0.17.1 and 0.22.1.
2. `shutdown()`'s contract: _"Stops the underlying compute because the eve server is shutting down; nothing may be left running afterwards. The session must remain reattachable from persisted state on the next server start."_
3. **eve 0.22.1 keys session sandboxes per durable session, not per deployment** — "redeploying no longer discards a session's `/workspace` state." Our cache currently lives at `<appRoot>/.eve/sandbox-cache/bwrap/`, and in eveland `appRoot` is the per-release directory, so a redeploy silently discards every session workspace. That is the bug Task 2 fixes.
4. **Injection works.** A generated `agent/sandbox.js` that imports a vendored backend by relative path (`../.eveland/…/index.js`) is discovered, compiled and bundled into `.output`. eve accepts `.cts .mts .cjs .mjs .ts .js` for authored modules, and `.ts` sorts before `.js`, so an authored `sandbox.ts` still wins unless it is removed. `eve build` does **not** typecheck the generated `.js`.
5. **Prewarm is lazy.** `npx eve build` does not call `prewarm` on a self-hosted build (that path is Vercel-only), `npx eve start` does not call it either, and `/eve/v1/health` returns **200** while the backend is entirely broken. The first `prewarm`/`create` happens on the first session that needs a sandbox. Therefore eveland's HTTP health check cannot detect a broken sandbox — hence Task 5.
6. `prewarmAppSandboxes()` is named in eve's own `SandboxTemplateNotProvisionedError` message but is **not exported** from any of eve's 42 public subpaths (0 occurrences in `dist/src/index.js`). There is no supported deploy-time prewarm hook. Do not try to import it.
7. `EVE_MOCK_AUTHORED_MODELS=1` activates eve's deterministic mock model adapter, documented as the opt-in for "spawned smoke servers". This is how Task 6 drives a real agent turn with no model credentials.

## File structure

| File                                                                    | Change | Responsibility                                              |
| ----------------------------------------------------------------------- | ------ | ----------------------------------------------------------- |
| `packages/sandbox-bwrap/src/backend.ts`                                 | modify | `shutdown()` replaces `dispose()`; `cacheDir` threading     |
| `packages/sandbox-bwrap/src/session.ts`                                 | modify | track live spawned processes; expose `killAll()`            |
| `packages/sandbox-bwrap/src/paths.ts`                                   | modify | `resolveBwrapCacheRoot(appRoot, cacheDir?)`                 |
| `packages/sandbox-bwrap/src/options.ts`                                 | modify | `cacheDir` option                                           |
| `packages/sandbox-bwrap/package.json`                                   | modify | eve peer/dev range `>=0.20.0 <0.23.0`                       |
| `apps/worker/src/runtime/sandbox-inject.ts`                             | create | generate sandbox modules + vendor the backend               |
| `apps/worker/src/runtime/sandbox-verify.ts`                             | create | post-build sandbox self-check under systemd hardening       |
| `apps/worker/src/runtime/systemd.ts`                                    | modify | call inject + verify; `ReadWritePaths` for the cache dir    |
| `apps/worker/src/runtime/select.ts`                                     | modify | `EVELAND_SANDBOX_CACHE_DIR` config                          |
| `apps/worker/src/integration/systemd-smoke.ts`                          | modify | assert injection happened                                   |
| `packages/sandbox-bwrap/src/integration/bwrap-backend-smoke.ts`         | modify | `shutdown()` kills spawned trees                            |
| `infra/integration/run.sh`                                              | modify | build the package; run the new e2e                          |
| `apps/worker/src/integration/agent-sandbox-e2e.ts`                      | create | import → deploy → real turn → redeploy → workspace survives |
| `packages/sandbox-bwrap/README.md`, `docs/deploy/linux.md`, `README.md` | modify | document injection, cache location, self-check              |

---

### Task 1: Upgrade `@evelandhq/sandbox-bwrap` to eve 0.22 (`shutdown()`)

**Files:**

- Modify: `packages/sandbox-bwrap/package.json`
- Modify: `packages/sandbox-bwrap/src/session.ts`
- Modify: `packages/sandbox-bwrap/src/backend.ts`
- Test: `packages/sandbox-bwrap/src/session.test.ts`, `packages/sandbox-bwrap/src/backend.test.ts`

**Interfaces:**

- Consumes: existing `ProcessRunner`, `SpawnedProcess`, `createBwrapSession`.
- Produces: `createBwrapSession` returns `SandboxSession & { readonly killAll: () => Promise<void> }` via a new exported type `BwrapSession`; the backend handle exposes `shutdown(): Promise<void>` and no longer exposes `dispose`.

- [ ] **Step 1: Point the package at eve 0.22.1**

In `packages/sandbox-bwrap/package.json` replace both eve ranges:

```json
  "peerDependencies": {
    "eve": ">=0.20.0 <0.23.0"
  },
  "devDependencies": {
    "ai": "^7.0.7",
    "eve": "0.22.1",
    "vitest": "^4.1.9"
  }
```

Run from the repo root: `pnpm install`
Expected: succeeds, lockfile updates to eve 0.22.1. Commit the lockfile with this task.

- [ ] **Step 2: Run the suite to see the break**

Run: `pnpm --filter @evelandhq/sandbox-bwrap typecheck`
Expected: FAIL with exactly `src/backend.ts(…): error TS2322 … Property 'shutdown' is missing in type … but required in type 'SandboxBackendHandle'`. If you see other errors, stop and report — fact 1 says there should be only this one.

- [ ] **Step 3: Write the failing tests**

Append to `packages/sandbox-bwrap/src/session.test.ts` (inside the existing top-level describe list):

```ts
describe("killAll", () => {
  test("kills every process spawned by this session and is idempotent", async () => {
    const killed: number[] = [];
    let pid = 0;
    const runner: ProcessRunner = {
      spawn(): SpawnedProcess {
        const id = ++pid;
        return {
          pid: id,
          stdout: stringStream(""),
          stderr: stringStream(""),
          wait: async () => ({ exitCode: 0 }),
          kill: async () => {
            killed.push(id);
          },
        };
      },
    };
    const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-killall-"));
    const workspaceDir = path.join(appRoot, "ws");
    await mkdir(workspaceDir, { recursive: true });
    const session = createBwrapSession({
      id: "s1",
      workspaceDir,
      appRoot,
      runner,
      options: resolveBwrapSandboxOptions(),
    });

    await session.spawn({ command: "sleep 1" });
    await session.spawn({ command: "sleep 2" });
    await session.killAll();
    await session.killAll();

    expect(killed).toEqual([1, 2]);
  });

  test("run() does not leave the process registered after it exits", async () => {
    const killed: number[] = [];
    const runner: ProcessRunner = {
      spawn(): SpawnedProcess {
        return {
          pid: 7,
          stdout: stringStream("out"),
          stderr: stringStream(""),
          wait: async () => ({ exitCode: 0 }),
          kill: async () => {
            killed.push(7);
          },
        };
      },
    };
    const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-killall-"));
    const workspaceDir = path.join(appRoot, "ws");
    await mkdir(workspaceDir, { recursive: true });
    const session = createBwrapSession({
      id: "s1",
      workspaceDir,
      appRoot,
      runner,
      options: resolveBwrapSandboxOptions(),
    });

    await session.run({ command: "echo out" });
    await session.killAll();

    expect(killed).toEqual([]);
  });
});
```

Add the missing imports at the top of that file: `import type { ProcessRunner, SpawnedProcess } from "./process.js";` already exists — reuse it.

Append to `packages/sandbox-bwrap/src/backend.test.ts`, inside `describe("create", …)`:

```ts
test("shutdown kills the session's live processes and leaves the workspace on disk", async () => {
  const { backend, runtimeContext } = await makeBackend();
  const handle = await backend.create({
    templateKey: null,
    sessionKey: "sess-shutdown",
    runtimeContext,
  });
  await handle.session.writeTextFile({ path: "keep.txt", content: "durable" });

  await handle.shutdown();

  const again = await backend.create({
    templateKey: null,
    sessionKey: "sess-shutdown",
    runtimeContext,
  });
  expect(await again.session.readTextFile({ path: "keep.txt" })).toBe("durable");
});

test("the handle exposes shutdown and no longer exposes dispose", async () => {
  const { backend, runtimeContext } = await makeBackend();
  const handle = await backend.create({
    templateKey: null,
    sessionKey: "sess-api",
    runtimeContext,
  });
  expect(typeof handle.shutdown).toBe("function");
  expect((handle as unknown as Record<string, unknown>).dispose).toBeUndefined();
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm --filter @evelandhq/sandbox-bwrap test`
Expected: the new tests FAIL (`session.killAll is not a function`, `handle.shutdown is not a function`).

- [ ] **Step 5: Track live processes in the session**

In `packages/sandbox-bwrap/src/session.ts`:

Add above `createBwrapSession`:

```ts
/**
 * A sandbox session plus the lifecycle hook the backend handle needs.
 * eve's `shutdown()` contract requires that nothing is left running, so the
 * session tracks the processes it spawned and can terminate them on demand.
 */
export type BwrapSession = SandboxSession & {
  /** Kills every process this session spawned that has not yet exited. Idempotent. */
  killAll(): Promise<void>;
};
```

Change the signature to `export function createBwrapSession(input: CreateBwrapSessionInput): BwrapSession {`.

Inside the factory, above `spawnProcess`:

```ts
const live = new Set<SpawnedProcess>();

function track(proc: SpawnedProcess): SpawnedProcess {
  live.add(proc);
  // Drop the reference as soon as the process exits so a long-lived session
  // does not accumulate dead handles.
  void Promise.resolve(proc.wait())
    .catch(() => undefined)
    .finally(() => live.delete(proc));
  return proc;
}
```

Import the type: change the process import to `import type { ProcessRunner, SpawnedProcess } from "./process.js";`.

Make `spawnProcess` return a tracked process — its last line becomes:

```ts
return track(runner.spawn(argv, { abortSignal: spawnOptions.abortSignal }));
```

In `run`, untrack once collected (its `wait()` already settles, so the `finally` above removes it; no extra code). Add `killAll` to the returned object, next to `resolvePath`:

```ts
    async killAll() {
      const pending = [...live];
      live.clear();
      await Promise.all(pending.map((proc) => proc.kill().catch(() => undefined)));
    },
```

- [ ] **Step 6: Swap `dispose()` for `shutdown()` in the backend**

In `packages/sandbox-bwrap/src/backend.ts`, `openSession`'s return type becomes `BwrapSession` (import it: `import type { BwrapSession } from "./session.js";` and drop `SandboxSession` from the type import if now unused). Replace the handle's `dispose` with:

```ts
        // eve calls this when the server is shutting down: nothing may be left
        // running afterwards. The workspace directory IS the durable state, so
        // it stays on disk and the session reattaches on the next start.
        async shutdown() {
          await session.killAll();
        },
```

Note for the implementer: `prewarm`'s bootstrap session is also a `BwrapSession`. Leave it alone — the bootstrap commands are `run()` calls that have already exited by the time prewarm returns.

- [ ] **Step 7: Run tests, typecheck, build**

Run: `pnpm --filter @evelandhq/sandbox-bwrap test && pnpm --filter @evelandhq/sandbox-bwrap typecheck && pnpm --filter @evelandhq/sandbox-bwrap build`
Expected: all PASS. Then `pnpm -r test && pnpm -r typecheck` — no regressions.

- [ ] **Step 8: Commit**

```bash
git add packages/sandbox-bwrap pnpm-lock.yaml
git commit -m "feat(sandbox-bwrap): target eve 0.22 and implement shutdown() with process tracking"
```

---

### Task 2: Move the sandbox cache out of the release directory

**Files:**

- Modify: `packages/sandbox-bwrap/src/options.ts`, `paths.ts`, `session.ts`, `backend.ts`, `index.ts`
- Test: `packages/sandbox-bwrap/src/paths.test.ts`, `options.test.ts`, `session.test.ts`, `backend.test.ts`

**Interfaces:**

- Consumes: Task 1's `BwrapSession`.
- Produces:
  - `BwrapSandboxCreateOptions.cacheDir?: string` (absolute; defaults to `<appRoot>/.eve/sandbox-cache/bwrap`), carried on `ResolvedBwrapSandboxOptions.cacheDir: string | null`.
  - `resolveBwrapCacheRoot(appRoot: string, cacheDir?: string | null): string`
  - `resolveTemplatePath(appRoot, templateKey, optionsHash, cacheDir?)` and `resolveSessionPath(appRoot, sessionKey, cacheDir?)` gain the same trailing optional parameter.

Why: fact 3. eve 0.22 promises a redeploy preserves a durable session's `/workspace`; eveland gives every release a fresh `appRoot`, so the cache must not be derived from it.

- [ ] **Step 1: Write the failing tests**

`packages/sandbox-bwrap/src/paths.test.ts` — add:

```ts
describe("cacheDir override", () => {
  test("an explicit cacheDir replaces the appRoot-derived cache root", () => {
    expect(resolveBwrapCacheRoot("/app", "/var/lib/eveland-data/sandbox/proj_1")).toBe(
      "/var/lib/eveland-data/sandbox/proj_1",
    );
    expect(resolveBwrapCacheRoot("/app", null)).toBe("/app/.eve/sandbox-cache/bwrap");
    expect(resolveBwrapCacheRoot("/app")).toBe("/app/.eve/sandbox-cache/bwrap");
  });

  test("session and template paths follow the override, so a new appRoot reuses the same state", () => {
    const cacheDir = "/var/lib/eveland-data/sandbox/proj_1";
    expect(resolveSessionPath("/releases/r1", "sess", cacheDir)).toBe(
      resolveSessionPath("/releases/r2", "sess", cacheDir),
    );
    expect(resolveTemplatePath("/releases/r1", "tpl", "hash", cacheDir)).toBe(
      resolveTemplatePath("/releases/r2", "tpl", "hash", cacheDir),
    );
    expect(resolveSessionPath("/releases/r1", "sess")).not.toBe(
      resolveSessionPath("/releases/r2", "sess"),
    );
  });
});
```

`packages/sandbox-bwrap/src/options.test.ts` — add:

```ts
describe("cacheDir option", () => {
  test("defaults to null and is part of the options hash", () => {
    expect(resolveBwrapSandboxOptions().cacheDir).toBeNull();
    expect(resolveBwrapSandboxOptions({ cacheDir: "/a" }).cacheDir).toBe("/a");
    const a = createBwrapOptionsHash(resolveBwrapSandboxOptions({ cacheDir: "/a" }));
    const b = createBwrapOptionsHash(resolveBwrapSandboxOptions({ cacheDir: "/b" }));
    expect(a).not.toBe(b);
  });
});
```

`packages/sandbox-bwrap/src/session.test.ts` — add to the spawn describe:

```ts
test("the overridden cache root is the path hidden by tmpfs", async () => {
  const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-cachedir-"));
  const cacheDir = path.join(appRoot, "stable-cache");
  const workspaceDir = path.join(cacheDir, "sessions", "s1");
  await mkdir(workspaceDir, { recursive: true });
  const { runner, calls } = createFakeRunner();
  const session = createBwrapSession({
    id: "s1",
    workspaceDir,
    appRoot,
    runner,
    options: resolveBwrapSandboxOptions({ cacheDir }),
  });
  await session.spawn({ command: "true" });
  const argv = calls[0]!;
  const secondTmpfs = argv.indexOf("--tmpfs", argv.indexOf("--tmpfs") + 1);
  expect(argv.slice(secondTmpfs, secondTmpfs + 2)).toEqual(["--tmpfs", cacheDir]);
  expect(argv).not.toContain(path.join(appRoot, ".eve", "sandbox-cache", "bwrap"));
});
```

`packages/sandbox-bwrap/src/backend.test.ts` — add:

```ts
test("session state survives a change of appRoot when cacheDir is pinned", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bwrap-redeploy-"));
  const cacheDir = path.join(root, "stable");
  const backend = createBwrapSandboxBackend({ runner: fakeRunner, createOptions: { cacheDir } });

  const first = await backend.create({
    templateKey: null,
    sessionKey: "s",
    runtimeContext: { appRoot: path.join(root, "release-1") },
  });
  await first.session.writeTextFile({ path: "state.txt", content: "kept" });
  await first.shutdown();

  // Redeploy: brand-new appRoot, same project cache.
  const second = await backend.create({
    templateKey: null,
    sessionKey: "s",
    runtimeContext: { appRoot: path.join(root, "release-2") },
  });
  expect(await second.session.readTextFile({ path: "state.txt" })).toBe("kept");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @evelandhq/sandbox-bwrap test`
Expected: FAIL (extra argument not accepted / `cacheDir` undefined).

- [ ] **Step 3: Implement**

`options.ts` — add to `BwrapSandboxCreateOptions`:

```ts
  /**
   * Absolute directory holding templates and durable session workspaces.
   * Defaults to `<appRoot>/.eve/sandbox-cache/bwrap`. Pin it outside the
   * release directory so a redeploy does not discard durable session state
   * (eve keys session sandboxes per durable session, not per deployment).
   */
  readonly cacheDir?: string;
```

add `readonly cacheDir: string | null;` to `ResolvedBwrapSandboxOptions`, `cacheDir: options.cacheDir ?? null,` to `resolveBwrapSandboxOptions`, and `cacheDir: options.cacheDir,` to the canonical object inside `createBwrapOptionsHash` (keep the keys alphabetically ordered: `bwrapPath, cacheDir, env, hidePaths, networkPolicy`).

`paths.ts`:

```ts
/**
 * Templates and durable session workspaces. `cacheDir` pins the location
 * outside the release directory; without it the cache follows eve's local
 * convention under the app root.
 */
export function resolveBwrapCacheRoot(appRoot: string, cacheDir?: string | null): string {
  return cacheDir ?? join(appRoot, ".eve", "sandbox-cache", "bwrap");
}

export function resolveTemplatePath(
  appRoot: string,
  templateKey: string,
  optionsHash: string,
  cacheDir?: string | null,
): string {
  return join(
    resolveBwrapCacheRoot(appRoot, cacheDir),
    "templates",
    `${keyDigest(templateKey)}-${optionsHash}`,
  );
}

export function resolveSessionPath(
  appRoot: string,
  sessionKey: string,
  cacheDir?: string | null,
): string {
  return join(resolveBwrapCacheRoot(appRoot, cacheDir), "sessions", keyDigest(sessionKey));
}
```

`session.ts` — in `spawnProcess`, the hide list becomes:

```ts
const hidePaths = [resolveBwrapCacheRoot(appRoot, options.cacheDir), ...options.hidePaths].filter(
  (path) => existsSync(path),
);
```

`backend.ts` — thread `options.cacheDir` into both `resolveTemplatePath(...)` calls and the `resolveSessionPath(...)` call (as the trailing argument).

`index.ts` — no export changes; `cacheDir` rides on `BwrapSandboxCreateOptions`.

- [ ] **Step 4: Run tests, typecheck**

Run: `pnpm --filter @evelandhq/sandbox-bwrap test && pnpm --filter @evelandhq/sandbox-bwrap typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-bwrap/src
git commit -m "feat(sandbox-bwrap): pin the sandbox cache outside the release directory"
```

---

### Task 3: Build-time sandbox injection

**Files:**

- Create: `apps/worker/src/runtime/sandbox-inject.ts`
- Test: `apps/worker/src/runtime/sandbox-inject.test.ts`
- Modify: `apps/worker/package.json` (add `"@evelandhq/sandbox-bwrap": "workspace:*"`)

**Interfaces:**

- Consumes: nothing from Tasks 1–2 at the type level; it resolves the built package by path at runtime.
- Produces:

```ts
export type SandboxInjectionInput = {
  releaseDir: string;
  /** Directory holding the built @evelandhq/sandbox-bwrap (its dist/). */
  backendDistDir: string;
};
export type SandboxInjectionResult = {
  /** Paths (relative to releaseDir) of generated sandbox modules. */
  generated: string[];
  /** Paths (relative to releaseDir) of authored sandbox modules that were replaced. */
  replaced: string[];
};
export const VENDORED_BACKEND_DIR = ".eveland/sandbox-bwrap";
export function buildGeneratedSandboxModule(relativeImportPath: string): string;
export function resolveSandboxRoots(releaseDir: string): Promise<string[]>;
export function injectSandboxModules(input: SandboxInjectionInput): Promise<SandboxInjectionResult>;
```

Behavior:

- `resolveSandboxRoots` returns every directory that owns a sandbox: `agent/`, plus `agent/subagents/<name>/` for each subdirectory that exists. (Verify the subagent location against the demo project layout before implementing; if `subagents/` sits elsewhere, fix the code and report it.)
- For each root: delete an authored `sandbox.{cts,mts,cjs,mjs,ts,js}` and an authored `sandbox/` directory (recording them in `replaced`), then write `sandbox.js`.
- The generated module imports the vendored backend by a path relative to the root it sits in, so it works at any depth.
- `injectSandboxModules` copies `backendDistDir` to `<releaseDir>/.eveland/sandbox-bwrap/`.

`buildGeneratedSandboxModule(relativeImportPath)` returns exactly:

```js
// Generated by eveland at build time. Do not edit.
// The deploy host decides the sandbox backend; agent projects never declare one.
import { defineSandbox, defaultBackend } from "eve/sandbox";
import { bwrap, isBwrapAvailable } from "<relativeImportPath>";

const cacheDir = process.env.EVELAND_SANDBOX_CACHE_DIR;

export default defineSandbox({
  backend: () => (isBwrapAvailable() ? bwrap(cacheDir ? { cacheDir } : {}) : defaultBackend()),
});
```

- [ ] **Step 1: Write the failing test**

`apps/worker/src/runtime/sandbox-inject.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  buildGeneratedSandboxModule,
  injectSandboxModules,
  resolveSandboxRoots,
} from "./sandbox-inject.js";

async function makeRelease(): Promise<{ releaseDir: string; backendDistDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "eveland-inject-"));
  const releaseDir = path.join(root, "release");
  const backendDistDir = path.join(root, "dist");
  await mkdir(path.join(releaseDir, "agent"), { recursive: true });
  await mkdir(backendDistDir, { recursive: true });
  await writeFile(path.join(backendDistDir, "index.js"), "export const marker = 1;\n");
  return { releaseDir, backendDistDir };
}

describe("buildGeneratedSandboxModule", () => {
  test("gates on bwrap availability and forwards the cache dir", () => {
    const source = buildGeneratedSandboxModule("../.eveland/sandbox-bwrap/index.js");
    expect(source).toContain('from "eve/sandbox"');
    expect(source).toContain('from "../.eveland/sandbox-bwrap/index.js"');
    expect(source).toContain(
      "isBwrapAvailable() ? bwrap(cacheDir ? { cacheDir } : {}) : defaultBackend()",
    );
    expect(source).toContain("process.env.EVELAND_SANDBOX_CACHE_DIR");
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
});

describe("injectSandboxModules", () => {
  test("generates a sandbox module, vendors the backend, and reports nothing replaced", async () => {
    const { releaseDir, backendDistDir } = await makeRelease();
    const result = await injectSandboxModules({ releaseDir, backendDistDir });

    expect(result.generated).toEqual(["agent/sandbox.js"]);
    expect(result.replaced).toEqual([]);
    expect(existsSync(path.join(releaseDir, ".eveland", "sandbox-bwrap", "index.js"))).toBe(true);
    const generated = await readFile(path.join(releaseDir, "agent", "sandbox.js"), "utf8");
    expect(generated).toContain('from "../.eveland/sandbox-bwrap/index.js"');
  });

  test("replaces an authored sandbox module and reports it", async () => {
    const { releaseDir, backendDistDir } = await makeRelease();
    await writeFile(path.join(releaseDir, "agent", "sandbox.ts"), "export default {};\n");

    const result = await injectSandboxModules({ releaseDir, backendDistDir });

    expect(result.replaced).toEqual(["agent/sandbox.ts"]);
    // .ts sorts before .js in eve's module resolution, so it must be gone.
    expect(existsSync(path.join(releaseDir, "agent", "sandbox.ts"))).toBe(false);
    expect(existsSync(path.join(releaseDir, "agent", "sandbox.js"))).toBe(true);
  });

  test("replaces an authored sandbox directory, including its workspace seeds", async () => {
    const { releaseDir, backendDistDir } = await makeRelease();
    await mkdir(path.join(releaseDir, "agent", "sandbox", "workspace"), { recursive: true });
    await writeFile(
      path.join(releaseDir, "agent", "sandbox", "sandbox.ts"),
      "export default {};\n",
    );

    const result = await injectSandboxModules({ releaseDir, backendDistDir });

    expect(result.replaced).toEqual(["agent/sandbox"]);
    expect(existsSync(path.join(releaseDir, "agent", "sandbox"))).toBe(false);
    expect(existsSync(path.join(releaseDir, "agent", "sandbox.js"))).toBe(true);
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @evelandhq/worker test -- sandbox-inject`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `sandbox-inject.ts`**

```ts
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Where the built backend is vendored inside the release directory. */
export const VENDORED_BACKEND_DIR = ".eveland/sandbox-bwrap";

/** Extensions eve accepts for an authored module, highest resolution priority first. */
const AUTHORED_MODULE_EXTENSIONS = [".cts", ".mts", ".cjs", ".mjs", ".ts", ".js"] as const;

export type SandboxInjectionInput = {
  releaseDir: string;
  backendDistDir: string;
};

export type SandboxInjectionResult = {
  generated: string[];
  replaced: string[];
};

export function buildGeneratedSandboxModule(relativeImportPath: string): string {
  return `// Generated by eveland at build time. Do not edit.
// The deploy host decides the sandbox backend; agent projects never declare one.
import { defineSandbox, defaultBackend } from "eve/sandbox";
import { bwrap, isBwrapAvailable } from "${relativeImportPath}";

const cacheDir = process.env.EVELAND_SANDBOX_CACHE_DIR;

export default defineSandbox({
  backend: () => (isBwrapAvailable() ? bwrap(cacheDir ? { cacheDir } : {}) : defaultBackend()),
});
`;
}

async function listDirectories(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function pathKind(target: string): Promise<"file" | "directory" | null> {
  const entries = await readdir(path.dirname(target), { withFileTypes: true }).catch(() => []);
  const match = entries.find((entry) => entry.name === path.basename(target));
  if (!match) return null;
  return match.isDirectory() ? "directory" : "file";
}

/** Every directory that owns a sandbox: the agent root plus each subagent. */
export async function resolveSandboxRoots(releaseDir: string): Promise<string[]> {
  const agentDir = path.join(releaseDir, "agent");
  if ((await pathKind(agentDir)) !== "directory") return [];
  const roots = ["agent"];
  for (const name of await listDirectories(path.join(agentDir, "subagents"))) {
    roots.push(path.posix.join("agent", "subagents", name));
  }
  return roots;
}

export async function injectSandboxModules(
  input: SandboxInjectionInput,
): Promise<SandboxInjectionResult> {
  const roots = await resolveSandboxRoots(input.releaseDir);
  const generated: string[] = [];
  const replaced: string[] = [];
  if (roots.length === 0) return { generated, replaced };

  const vendorDir = path.join(input.releaseDir, VENDORED_BACKEND_DIR);
  await rm(vendorDir, { force: true, recursive: true });
  await mkdir(path.dirname(vendorDir), { recursive: true });
  await cp(input.backendDistDir, vendorDir, { recursive: true });

  for (const root of roots) {
    const rootDir = path.join(input.releaseDir, root);

    // eve resolves `sandbox/` before `sandbox.<ext>`, and `.ts` before `.js`.
    // Remove every authored form so the generated module is the only match.
    const sandboxDir = path.join(rootDir, "sandbox");
    if ((await pathKind(sandboxDir)) === "directory") {
      await rm(sandboxDir, { force: true, recursive: true });
      replaced.push(path.posix.join(root, "sandbox"));
    }
    for (const extension of AUTHORED_MODULE_EXTENSIONS) {
      const authored = path.join(rootDir, `sandbox${extension}`);
      if ((await pathKind(authored)) === "file") {
        await rm(authored, { force: true });
        replaced.push(path.posix.join(root, `sandbox${extension}`));
      }
    }

    const importPath = path.posix.join(
      path.posix.relative(root, ""),
      VENDORED_BACKEND_DIR,
      "index.js",
    );
    await writeFile(
      path.join(rootDir, "sandbox.js"),
      buildGeneratedSandboxModule(importPath),
      "utf8",
    );
    generated.push(path.posix.join(root, "sandbox.js"));
  }

  return { generated, replaced };
}
```

Implementation note: `path.posix.relative("agent", "")` yields `".."`, and `path.posix.join("..", ".eveland/sandbox-bwrap", "index.js")` yields `"../.eveland/sandbox-bwrap/index.js"`. For a subagent root three levels deep it yields `"../../../.eveland/sandbox-bwrap/index.js"`. Verify with the tests; if `path.posix.relative` returns a bare relative path without a leading `./`, that is what eve's bundler expects.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @evelandhq/worker test -- sandbox-inject && pnpm --filter @evelandhq/worker typecheck`
Expected: PASS.

- [ ] **Step 5: Add the workspace dependency**

In `apps/worker/package.json`, add to `dependencies`: `"@evelandhq/sandbox-bwrap": "workspace:*"`.
Run: `pnpm install` from the repo root.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/runtime/sandbox-inject.ts apps/worker/src/runtime/sandbox-inject.test.ts apps/worker/package.json pnpm-lock.yaml
git commit -m "feat(worker): generate the eve sandbox module at build time"
```

---

### Task 4: Wire injection into the systemd build, and grant the cache dir

**Files:**

- Modify: `apps/worker/src/runtime/systemd.ts`
- Modify: `apps/worker/src/runtime/select.ts`
- Test: `apps/worker/src/runtime/systemd.test.ts` (extend), `apps/worker/src/runtime/select.test.ts` (extend)

**Interfaces:**

- Consumes: `injectSandboxModules`, `VENDORED_BACKEND_DIR` (Task 3).
- Produces: `SystemdAdapterConfig` gains `sandboxCacheDir: string` and `backendDistDir: string`. `buildSystemdRunArgs` input gains `sandboxCacheDir: string`.

Rules:

- `resolveBackendDistDir()` resolves the built package: `path.dirname(createRequire(import.meta.url).resolve("@evelandhq/sandbox-bwrap"))`. If it throws or the directory is missing, `buildRelease` must fail with an actionable message telling the operator to run `pnpm --filter @evelandhq/sandbox-bwrap build`.
- Injection runs **after** `cp -a` and **before** the build command, so `npx eve build` compiles the generated module. `npm ci` only clears `node_modules`, so `.eveland/` survives.
- Each project gets `sandboxCacheDir/<projectId>`; the directory is created and `chown`ed to the service user at build time (the app runs unprivileged and cannot create it under `ProtectSystem=strict`).
- `buildSystemdRunArgs` emits a second `--property=ReadWritePaths=` for the project's cache dir (systemd list-type settings append across repeated assignments), and `--property=Environment=EVELAND_SANDBOX_CACHE_DIR=<dir>`.

- [ ] **Step 1: Write the failing tests**

Extend `apps/worker/src/runtime/systemd.test.ts`:

```ts
describe("buildSystemdRunArgs (sandbox cache)", () => {
  test("grants the sandbox cache dir and exports it to the app", () => {
    const args = buildSystemdRunArgs({
      unitName: "eveland-p-d",
      releaseDir: "/rel",
      envFilePath: "/env/p.env",
      port: 41000,
      user: "eveland-app",
      memoryMax: "2G",
      cpuQuota: "200%",
      sandboxCacheDir: "/var/lib/eveland-data/sandbox/p",
      command: "npx eve start",
    });

    expect(args).toContain("--property=ReadWritePaths=/rel");
    expect(args).toContain("--property=ReadWritePaths=/var/lib/eveland-data/sandbox/p");
    expect(args).toContain(
      "--property=Environment=EVELAND_SANDBOX_CACHE_DIR=/var/lib/eveland-data/sandbox/p",
    );
    // The env file must still be read before PORT is forced.
    expect(args.indexOf("--property=EnvironmentFile=/env/p.env")).toBeLessThan(
      args.indexOf("--property=Environment=PORT=41000"),
    );
  });
});
```

Extend `apps/worker/src/runtime/select.test.ts`:

```ts
test("systemd runtime derives the sandbox cache dir from the data dir by default", () => {
  const adapter = createRuntimeAdapterFromEnv({
    EVELAND_RUNTIME: "systemd",
    EVELAND_DATA_DIR: "/var/lib/eveland-data",
  } as NodeJS.ProcessEnv);
  expect(adapter.name).toBe("systemd");
});

test("EVELAND_SANDBOX_CACHE_DIR overrides the derived path", () => {
  const adapter = createRuntimeAdapterFromEnv({
    EVELAND_RUNTIME: "systemd",
    EVELAND_DATA_DIR: "/var/lib/eveland-data",
    EVELAND_SANDBOX_CACHE_DIR: "/srv/sandbox",
  } as NodeJS.ProcessEnv);
  expect(adapter.name).toBe("systemd");
});
```

(Those two only pin that construction does not throw; the path assertions live in `systemd.test.ts` where the builders are pure.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @evelandhq/worker test`
Expected: FAIL — `sandboxCacheDir` is not accepted.

- [ ] **Step 3: Implement**

`systemd.ts`:

- Add `sandboxCacheDir: string;` to `SystemdStartInput` and, in `buildSystemdRunArgs`, immediately after the existing `--property=ReadWritePaths=${input.releaseDir}` entry, push:

```ts
    `--property=ReadWritePaths=${input.sandboxCacheDir}`,
```

and after the existing `Environment=PORT=` entry, push:

```ts
    `--property=Environment=EVELAND_SANDBOX_CACHE_DIR=${input.sandboxCacheDir}`,
```

- Add `sandboxCacheDir: string; backendDistDir: string;` to `SystemdAdapterConfig`.
- In `createSystemdAdapter`, compute `const projectCacheDir = (projectId: string) => path.resolve(config.sandboxCacheDir, processSafeName(projectId));`
- In `buildRelease`, between the `cp -a` and the build command:

```ts
const injection = await injectSandboxModules({ releaseDir, backendDistDir: config.backendDistDir });
const cacheDir = projectCacheDir(input.projectId);
await mkdir(cacheDir, { recursive: true });
```

- In `buildRelease`, after `chown -R` of the release dir, also `await execa("chown", ["-R", `${config.user}:`, cacheDir]);`
- Prefix the returned build log with the injection report so it lands in the project's build log:

```ts
const injectionLog = [
  `Injected eve sandbox modules: ${injection.generated.join(", ") || "none"}`,
  ...(injection.replaced.length
    ? [
        `WARNING: replaced the project's authored sandbox (${injection.replaced.join(", ")}). ` +
          "eveland selects the sandbox backend; the module's bootstrap(), onSession() and workspace seeds are NOT used.",
      ]
    : []),
].join("\n");
return { releaseRef: releaseDir, log: `${injectionLog}\n${execution.all ?? ""}` };
```

- In `startProcess`, pass `sandboxCacheDir` into `buildSystemdRunArgs`. `startProcess` receives no `projectId`, so derive the cache dir from the unit name is NOT acceptable — instead add `sandboxCacheDir: string` to `ProcessStartInput` in `apps/worker/src/runtime/types.ts`, set it in `apps/worker/src/jobs/process.ts` from the same helper, and ignore it in the docker adapter. Update `docker.ts`'s `startProcess` signature accordingly (it already destructures only what it needs).

`select.ts` — inside the systemd branch:

```ts
      sandboxCacheDir: path.resolve(env.EVELAND_SANDBOX_CACHE_DIR ?? path.join(env.EVELAND_DATA_DIR ?? ".eveland-data", "sandbox")),
      backendDistDir: resolveBackendDistDir(),
```

with, at module scope:

```ts
import { createRequire } from "node:module";
import { existsSync } from "node:fs";

/** Locates the built @evelandhq/sandbox-bwrap that gets vendored into each release. */
function resolveBackendDistDir(): string {
  let entry: string;
  try {
    entry = createRequire(import.meta.url).resolve("@evelandhq/sandbox-bwrap");
  } catch (error) {
    throw new Error(
      "@evelandhq/sandbox-bwrap is not resolvable. Run `pnpm --filter @evelandhq/sandbox-bwrap build` before starting the worker.",
      { cause: error },
    );
  }
  const distDir = path.dirname(entry);
  if (!existsSync(distDir)) {
    throw new Error(
      `@evelandhq/sandbox-bwrap dist directory is missing at ${distDir}. Run \`pnpm --filter @evelandhq/sandbox-bwrap build\`.`,
    );
  }
  return distDir;
}
```

Note: `resolveBackendDistDir()` must be called lazily inside the systemd branch (not at module load), so the docker runtime never requires the package to be built.

`jobs/process.ts` — pass `sandboxCacheDir` into `runtime.startProcess({...})`. Compute it with the same rule the adapter uses; export a tiny helper from `systemd.ts` (`export function resolveProjectSandboxCacheDir(root: string, projectId: string): string`) and use it from both places so the two never drift.

- [ ] **Step 4: Run the full worker suite and typecheck**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src
git commit -m "feat(worker): inject the sandbox at build time and grant its cache dir to the unit"
```

---

### Task 5: Fail the deploy when the sandbox does not work

**Files:**

- Create: `apps/worker/src/runtime/sandbox-verify.ts`
- Test: `apps/worker/src/runtime/sandbox-verify.test.ts`
- Modify: `apps/worker/src/runtime/systemd.ts`

**Interfaces:**

- Consumes: `VENDORED_BACKEND_DIR` (Task 3).
- Produces:

```ts
export const SANDBOX_VERIFY_SCRIPT_PATH = ".eveland/verify-sandbox.mjs";
export function buildSandboxVerifyScript(): string;
export function buildSandboxVerifyArgs(input: {
  releaseDir: string;
  user: string;
  cacheDir: string;
}): string[];
export function verifySandbox(input: {
  releaseDir: string;
  user: string;
  cacheDir: string;
}): Promise<void>;
```

Why: fact 5. `eve build` succeeds and `/eve/v1/health` returns 200 with a completely broken sandbox, so nothing in the current pipeline can catch a host that cannot run bwrap. This check runs the real vendored backend under the _same_ systemd hardening the deployment gets, so a failure surfaces as a failed build instead of a failed user turn.

The script exercises the real backend against a throwaway app root inside the project's cache dir:

```js
// Generated by eveland. Verifies the vendored sandbox backend on this host.
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
// This script lives at <releaseDir>/.eveland/verify-sandbox.mjs, so the
// vendored backend is its sibling.
import { createBwrapSandboxBackend } from "./sandbox-bwrap/index.js";

const cacheRoot = process.env.EVELAND_SANDBOX_CACHE_DIR;
if (!cacheRoot) {
  console.error("EVELAND_SANDBOX_CACHE_DIR is not set");
  process.exit(1);
}

const appRoot = await mkdtemp(path.join(cacheRoot, "verify-"));
try {
  const backend = createBwrapSandboxBackend();
  const runtimeContext = { appRoot };
  await backend.prewarm({ templateKey: "eveland-verify", runtimeContext, seedFiles: [] });
  const handle = await backend.create({
    templateKey: "eveland-verify",
    sessionKey: "eveland-verify",
    runtimeContext,
  });
  const result = await handle.session.run({ command: "echo eveland-sandbox-ok" });
  await handle.shutdown();
  if (result.exitCode !== 0 || !result.stdout.includes("eveland-sandbox-ok")) {
    console.error(
      `sandbox self-check failed: exit=${result.exitCode} stdout=${result.stdout} stderr=${result.stderr}`,
    );
    process.exit(1);
  }
  console.log("SANDBOX VERIFY OK");
} finally {
  await rm(appRoot, { force: true, recursive: true });
}
```

`buildSandboxVerifyArgs` returns the `systemd-run` argv that runs it as the deployment user under the same hardening:

```ts
[
  "--wait",
  "--pipe",
  "--collect",
  "--service-type=exec",
  `--property=User=${input.user}`,
  "--property=NoNewPrivileges=yes",
  "--property=ProtectSystem=strict",
  "--property=PrivateTmp=yes",
  `--property=ReadWritePaths=${input.cacheDir}`,
  `--property=WorkingDirectory=${input.releaseDir}`,
  `--setenv=EVELAND_SANDBOX_CACHE_DIR=${input.cacheDir}`,
  `--setenv=TMPDIR=${input.cacheDir}`,
  "node",
  path.join(input.releaseDir, SANDBOX_VERIFY_SCRIPT_PATH),
];
```

`verifySandbox` writes the script, runs `execa("systemd-run", args, { all: true, reject: false })`, and throws an `Error` containing the captured output when the exit code is non-zero or `SANDBOX VERIFY OK` is absent. The message must name the two host prerequisites (`/etc/apparmor.d/bwrap` granting `userns`, and an existing `/workspace`) because those are the two ways this fails on a fresh host.

- [ ] **Step 1: Write the failing tests**

`apps/worker/src/runtime/sandbox-verify.test.ts` — pure-builder tests plus an execa-boundary test (`vi.mock("execa")`), mirroring `docker.test.ts`'s style:

```ts
import { describe, expect, test, vi } from "vitest";
import { execa } from "execa";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildSandboxVerifyArgs,
  buildSandboxVerifyScript,
  SANDBOX_VERIFY_SCRIPT_PATH,
  verifySandbox,
} from "./sandbox-verify.js";

vi.mock("execa", () => ({ execa: vi.fn(async () => ({ exitCode: 0, all: "SANDBOX VERIFY OK" })) }));

describe("buildSandboxVerifyScript", () => {
  test("exercises prewarm, create, run and shutdown against the vendored backend", () => {
    const script = buildSandboxVerifyScript();
    expect(script).toContain('from "./sandbox-bwrap/index.js"');
    expect(script).toContain("backend.prewarm(");
    expect(script).toContain("handle.session.run(");
    expect(script).toContain("handle.shutdown()");
    expect(script).toContain("SANDBOX VERIFY OK");
  });
});

describe("buildSandboxVerifyArgs", () => {
  test("runs under the deployment's hardening as the deployment user", () => {
    const args = buildSandboxVerifyArgs({
      releaseDir: "/rel",
      user: "eveland-app",
      cacheDir: "/cache/p",
    });
    expect(args).toContain("--property=User=eveland-app");
    expect(args).toContain("--property=NoNewPrivileges=yes");
    expect(args).toContain("--property=ProtectSystem=strict");
    expect(args).toContain("--property=ReadWritePaths=/cache/p");
    expect(args).toContain("--setenv=EVELAND_SANDBOX_CACHE_DIR=/cache/p");
    expect(args.at(-1)).toBe(path.join("/rel", SANDBOX_VERIFY_SCRIPT_PATH));
  });
});

describe("verifySandbox", () => {
  test("writes the script and resolves when the check prints its marker", async () => {
    vi.mocked(execa).mockClear();
    const releaseDir = await mkdtemp(path.join(os.tmpdir(), "eveland-verify-"));
    await verifySandbox({ releaseDir, user: "eveland-app", cacheDir: "/cache/p" });
    const script = await readFile(path.join(releaseDir, SANDBOX_VERIFY_SCRIPT_PATH), "utf8");
    expect(script).toContain("SANDBOX VERIFY OK");
    expect(vi.mocked(execa).mock.calls[0]![0]).toBe("systemd-run");
  });

  test("throws an actionable error naming both host prerequisites when the check fails", async () => {
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 1,
      all: "bwrap: setting up uid map: Permission denied",
    } as never);
    const releaseDir = await mkdtemp(path.join(os.tmpdir(), "eveland-verify-"));
    await expect(
      verifySandbox({ releaseDir, user: "eveland-app", cacheDir: "/cache/p" }),
    ).rejects.toThrow(/apparmor.*|\/workspace/is);
  });

  test("throws when the marker is missing even on exit 0", async () => {
    vi.mocked(execa).mockResolvedValueOnce({ exitCode: 0, all: "" } as never);
    const releaseDir = await mkdtemp(path.join(os.tmpdir(), "eveland-verify-"));
    await expect(
      verifySandbox({ releaseDir, user: "eveland-app", cacheDir: "/cache/p" }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @evelandhq/worker test -- sandbox-verify`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `sandbox-verify.ts`** exactly per the Interfaces block above. The script text is a template string; write it to `<releaseDir>/.eveland/verify-sandbox.mjs` (creating `.eveland/` if needed) before invoking systemd-run.

- [ ] **Step 4: Call it from the systemd build**

In `systemd.ts`'s `buildRelease`, after `chown -R` of both directories (the check runs as the service user, so ownership must already be right):

```ts
await verifySandbox({ releaseDir, user: config.user, cacheDir });
```

The thrown error propagates out of `buildRelease`; `jobs/process.ts` already records a failed build. Add one line to the returned log noting the check passed.

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/runtime/sandbox-verify.ts apps/worker/src/runtime/sandbox-verify.test.ts apps/worker/src/runtime/systemd.ts
git commit -m "feat(worker): fail the deploy when the sandbox does not work on this host"
```

---

### Task 6: End-to-end verification in the Lima VM

**Files:**

- Create: `apps/worker/src/integration/agent-sandbox-e2e.ts`
- Modify: `infra/integration/run.sh`
- Modify: `packages/sandbox-bwrap/src/integration/bwrap-backend-smoke.ts` (replace `dispose()` with `shutdown()`; add a spawn-then-shutdown assertion)

This is the task that proves the other five. Run it against the real VM; do not stub anything.

The e2e script must, using the real store + `processNextJob` pipeline with `EVELAND_RUNTIME=systemd`:

1. Import a fixture eve project (reuse the existing smoke fixture pattern; it must be a real eve project so `isEveProject` is true). Give it an authored `agent/sandbox.ts` that would pick a deliberately broken backend, so the test also proves the authored module is ignored.
2. Deploy it. Assert the build log contains the injection line AND the `WARNING: replaced the project's authored sandbox` line.
3. Assert `<releaseDir>/agent/sandbox.js` exists and `<releaseDir>/agent/sandbox.ts` does not.
4. Start the unit with `EVE_MOCK_AUTHORED_MODELS=1` in its environment (fact 7) so a turn needs no model credentials. Drive one real agent turn through the deployed HTTP surface that causes the agent to use its sandbox, and assert the turn succeeds.
   - **Unknown to resolve in this task:** the exact route/payload to start a session and run a turn, and which fixture agent code forces a sandbox `run()`. Investigate `/eve/` routes on the running deployment. If driving a turn proves infeasible, fall back to asserting that the deployed process created `sessions/` under the project's sandbox cache dir after the turn attempt, and **report the limitation explicitly** rather than claiming the layers are connected.
5. Write a file into the session workspace (through the agent, or directly on disk under the project's cache dir if step 4 fell back), then **redeploy** the same project.
6. Assert the session workspace still holds that file after the redeploy — this is the regression test for Task 2 and for eve 0.22's per-session keying.
7. Tear down: stop the unit, `systemctl reset-failed`, and remove the project's cache dir. Print `AGENT SANDBOX E2E OK` only on full success, and clean up in a `finally` (glob cleanup is VM-only; keep the existing comment style warning it is not shared-host-safe).

`infra/integration/run.sh` must additionally, before running the smokes:

```bash
corepack pnpm --filter @evelandhq/sandbox-bwrap build
```

and after the existing two smokes, run the new e2e as root (it drives systemd itself):

```bash
  EVELAND_RUNTIME=systemd EVELAND_BUILD_SANDBOX=bwrap EVELAND_DATA_DIR=/var/lib/eveland-data \
    corepack pnpm --filter @evelandhq/worker exec tsx src/integration/agent-sandbox-e2e.ts
```

- [ ] **Step 1: Update the backend smoke for `shutdown()`**

In `bwrap-backend-smoke.ts`, replace every `handle.dispose()` with `handle.shutdown()`, and add before the persistence check:

```ts
// shutdown() must leave nothing running: spawn a sleeper, shut down, and
// confirm the process is gone from the host.
const sleeper = await session.spawn({ command: "sleep 300" });
const sleeperPid = sleeper.pid;
await handle.shutdown();
assert.ok(sleeperPid !== undefined, "spawn must expose a pid");
assert.equal(processIsAlive(sleeperPid), false, "shutdown() must kill spawned processes");
```

with a local helper:

```ts
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
```

Note: `shutdown()` ends the session's processes but the handle's workspace stays; the smoke's later reattach assertions still hold.

- [ ] **Step 2: Write `agent-sandbox-e2e.ts`** per the behavior list above, following the structure of `apps/worker/src/integration/systemd-smoke.ts` (plain tsx script, `assert/strict`, try/finally cleanup, single success marker).

- [ ] **Step 3: Wire `run.sh` and run the whole integration suite**

Run: `bash infra/integration/run.sh`
Expected: prints `SMOKE OK`, `BWRAP SMOKE OK`, and `AGENT SANDBOX E2E OK`; exits 0.

If bwrap now fails under the deployment user for a reason the VM provisioning does not cover, that is a finding: report it with the diagnostics (`sysctl kernel.apparmor_restrict_unprivileged_userns`, `ls -l /etc/apparmor.d/bwrap`, `ls -ld /workspace`) and do NOT weaken any systemd property to make it pass.

- [ ] **Step 4: Verify a clean VM**

Run: `limactl delete -f eveland-test && bash infra/integration/run.sh`
Expected: same three markers, exit 0, with zero manual VM mutation. Then confirm no leaks: `limactl shell eveland-test -- bash -c "systemctl list-units 'eveland-*' --no-legend | cat; systemctl list-units 'run-*' --no-legend | cat"`.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/integration infra/integration/run.sh packages/sandbox-bwrap/src/integration
git commit -m "test: end-to-end agent sandbox verification across import, deploy and redeploy"
```

---

### Task 7: Documentation

**Files:**

- Modify: `packages/sandbox-bwrap/README.md`
- Modify: `docs/deploy/linux.md`
- Modify: `README.md`

- [ ] **Step 1: Rewrite the package README's usage section**

The current README tells project authors to write `agent/sandbox.ts`. That is now wrong for eveland deployments. Replace the "Usage" section with two clearly separated audiences:

- **Deployed on eveland:** you do nothing. eveland generates the sandbox module into the release directory at build time and vendors this package beside it. An authored `agent/sandbox.ts` is removed and replaced, and the build log says so. Local `eve dev` is untouched and falls back to eve's default chain (usually `just-bash` or Docker).
- **Standalone use of this package** (outside eveland): keep the existing `defineSandbox({ backend: () => isBwrapAvailable() ? bwrap() : defaultBackend() })` snippet, marked as the manual path.

Document the new `cacheDir` option in the options table, and explain in "How it works" that the cache lives outside the release directory so a redeploy preserves durable session workspaces (eve keys session sandboxes per durable session since 0.22.0). State the eve version requirement: `>=0.20.0 <0.23.0`, because 0.20.0 replaced `dispose()` with `shutdown()`.

Keep every security-boundary statement already in the file; add nothing that is not true.

- [ ] **Step 2: Update `docs/deploy/linux.md`**

Rewrite the "Agent exec sandbox" section: projects no longer opt in. Describe what the operator sees — the build log's injection line, the `WARNING: replaced …` line when a project shipped its own sandbox, and the fact that **a build now fails when the sandbox does not work on the host** (name the two prerequisites). Document `EVELAND_SANDBOX_CACHE_DIR` in the env table (default `$EVELAND_DATA_DIR/sandbox`), what lives under it, that it is granted to the unit via `ReadWritePaths`, and that it is **not** pruned automatically.

Add a sentence stating plainly that eve prewarms sandboxes lazily, so a passing HTTP health check does not by itself mean the sandbox works — that is exactly why the build-time self-check exists.

- [ ] **Step 3: Update the root `README.md`** bullet for `packages/sandbox-bwrap` to say the backend is injected by the worker at build time, not declared by projects.

- [ ] **Step 4: Verify docs against the code**

Re-read all three. Every env var, option name, path, and log string must match the implementation (`EVELAND_SANDBOX_CACHE_DIR`, `cacheDir`, `.eveland/sandbox-bwrap`, `agent/sandbox.js`, the `WARNING: replaced` text, `SANDBOX VERIFY OK`). Run `pnpm -r test && pnpm -r typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-bwrap/README.md docs/deploy/linux.md README.md
git commit -m "docs: platform-injected sandbox, cache location, and the build-time self-check"
```

---

## Self-Review Notes

- Coverage: eve 0.22 upgrade → Task 1; redeploy-preserves-workspace → Task 2 (+ regression test in Task 6); build-time injection ignoring authored sandboxes → Tasks 3–4; deploy fails on a broken sandbox → Task 5; end-to-end proof → Task 6; docs → Task 7. The upstream issue was explicitly descoped by the user.
- Biggest risks, in order: (a) Task 6 step 4 — driving a real agent turn may be harder than assumed; the plan names the fallback and forbids overclaiming. (b) Task 4's `ProcessStartInput` change touches the docker adapter's signature — keep it a no-op there. (c) `path.posix.relative(root, "")` behavior for the import path is asserted by Task 3's tests, not assumed.
- Deferred, do not expand scope: pruning the sandbox cache; `bwrap --uid` for builds; publishing the package; an upstream `EVE_SANDBOX_BACKEND` hook.
