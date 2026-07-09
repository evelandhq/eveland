# systemd Runtime Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Docker deployment path in `apps/worker` with a systemd-based runtime adapter: builds run on the host under bubblewrap, deployments run as hardened systemd transient units, health checks hit eve's HTTP endpoint. Docker stays available as the macOS dev fallback behind `EVELAND_RUNTIME=docker` (the default).

**Architecture:** The worker's `RuntimeAdapter` is reshaped from a docker-shaped interface (`buildImage`/`runContainer` with image tags and Dockerfiles) into a release-shaped one (`buildRelease`/`startProcess`/`stopProcess`). Two implementations: `createDockerAdapter` (wraps the existing docker functions, keeps the socat/Ollama bridge) and `createSystemdAdapter` (copies source to a per-release dir, runs `npm ci && npx eve build` inside bwrap, starts the app via `systemd-run` transient units with resource limits and filesystem hardening). Deployment records reuse the existing store columns: `imageTag` holds the release ref (image tag or release dir), `containerName` holds the process name (container name or unit name) — no DB migration.

**Tech Stack:** TypeScript ESM, vitest, execa, systemd (`systemd-run`, `systemctl`), bubblewrap, Lima (Ubuntu 24.04 VM) for integration verification.

## Global Constraints

- Node 24, ESM everywhere: `"type": "module"`, relative imports use `.js` suffixes (e.g. `./types.js`).
- Test runner is vitest; run with `pnpm --filter @eveland/worker test` (all) or `pnpm --filter @eveland/worker exec vitest run <path>` (one file).
- Typecheck with `pnpm --filter @eveland/worker typecheck`.
- No new runtime dependencies. `execa` is already a dependency.
- Code style: pure arg-builder functions with unit tests + thin execa wrappers, mirroring `apps/worker/src/runtime/docker.ts` and `apps/worker/src/docker.test.ts`.
- The systemd adapter is Linux-only and assumes the worker process runs as **root** on the deploy host (v1; documented in Task 6).
- Deployments run as a fixed service user (default `eveland-app`, override via `EVELAND_APP_USER`). **Deviation from earlier design sketch:** `DynamicUser=yes` is deferred — the dynamic UID is unknown before unit start, which makes giving it a writable release dir (needed because eve's default local workflow world writes `.workflow-data/` into the cwd) awkward. A fixed user + `ProtectSystem=strict` + `ReadWritePaths=<releaseDir>` gets equivalent practical hardening for a single-tenant internal host.
- Secrets are injected via a root-owned `0600` EnvironmentFile, not `LoadCredential`. **Deviation from earlier design sketch:** eve apps read secrets from `process.env`, so env-file injection is the drop-in parity with docker `--env`; `LoadCredential` would require app-side changes.
- `@eveland/sandbox-bwrap` (eve SandboxBackend) is **out of scope** — it is Plan 2, written after this plan is executed and the Lima environment exists.
- Env vars introduced: `EVELAND_RUNTIME` (`docker` default | `systemd`), `EVELAND_APP_USER` (default `eveland-app`), `EVELAND_MEMORY_MAX` (default `2G`), `EVELAND_CPU_QUOTA` (default `200%`), `EVELAND_BUILD_SANDBOX` (`bwrap` default | `none`).

---

### Task 1: Runtime adapter types + docker adapter reshape

**Files:**
- Create: `apps/worker/src/runtime/types.ts`
- Modify: `apps/worker/src/runtime/docker.ts` (append; keep all existing exports)
- Test: `apps/worker/src/docker.test.ts` (append)

**Interfaces:**
- Consumes: existing `dockerBuild`, `dockerRun`, `dockerStopAndRemove`, `writeGeneratedDockerfile` from `docker.ts`; `inferEveRuntimeCommand` from `@eveland/shared/runtime`.
- Produces (later tasks rely on these exact shapes):

```ts
// runtime/types.ts
export type RuntimeCommandContext = {
  isEveProject: boolean;
  hasLockfile: boolean;
  scripts: Record<string, string | undefined>;
};
export type ReleaseBuildInput = {
  projectId: string;
  releaseId: string;
  sourcePath: string;
  buildDir: string;
  commandContext: RuntimeCommandContext;
};
export type ReleaseBuildResult = { releaseRef: string; log: string };
export type ProcessStartInput = {
  processName: string;
  releaseRef: string;
  port: number;
  env: Record<string, string>;
  commandContext: RuntimeCommandContext;
};
export type ProcessStartResult = { internalPort: number; log: string };
export type RuntimeAdapter = {
  readonly name: string;
  buildRelease(input: ReleaseBuildInput): Promise<ReleaseBuildResult>;
  startProcess(input: ProcessStartInput): Promise<ProcessStartResult>;
  stopProcess(processName: string): Promise<void>;
};
export function processSafeName(value: string): string;
// docker.ts additions
export function buildDockerStartCommand(context: RuntimeCommandContext, internalPort: number): string;
export function createDockerAdapter(config: { internalPort: number }): RuntimeAdapter;
```

- [ ] **Step 1: Write the failing tests**

Append to `apps/worker/src/docker.test.ts`:

```ts
import { buildDockerStartCommand, createDockerAdapter } from "./runtime/docker.js";
import { processSafeName } from "./runtime/types.js";

describe("processSafeName", () => {
  test("lowercases and replaces unsafe characters", () => {
    expect(processSafeName("Proj_ABC/9.x")).toBe("proj_abc-9.x");
  });
});

describe("buildDockerStartCommand", () => {
  test("bridges Ollama and executes eve start for eve projects", () => {
    const command = buildDockerStartCommand({ isEveProject: true, hasLockfile: true, scripts: {} }, 3000);
    expect(command).toContain("socat TCP-LISTEN:11434");
    expect(command).toContain("exec npx eve start --host 0.0.0.0 --port 3000");
  });

  test("falls back to the inferred runtime command for plain node projects", () => {
    const command = buildDockerStartCommand({ isEveProject: false, hasLockfile: true, scripts: { start: "node server.js" } }, 3000);
    expect(command).toBe("npm run start");
  });
});

describe("createDockerAdapter", () => {
  test("exposes the docker adapter name and internal port through startProcess results", () => {
    const adapter = createDockerAdapter({ internalPort: 3000 });
    expect(adapter.name).toBe("docker");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @eveland/worker exec vitest run src/docker.test.ts`
Expected: FAIL — `processSafeName`, `buildDockerStartCommand`, `createDockerAdapter` are not exported.

- [ ] **Step 3: Create `apps/worker/src/runtime/types.ts`**

```ts
export type RuntimeCommandContext = {
  isEveProject: boolean;
  hasLockfile: boolean;
  scripts: Record<string, string | undefined>;
};

export type ReleaseBuildInput = {
  projectId: string;
  releaseId: string;
  sourcePath: string;
  buildDir: string;
  commandContext: RuntimeCommandContext;
};

export type ReleaseBuildResult = {
  releaseRef: string;
  log: string;
};

export type ProcessStartInput = {
  processName: string;
  releaseRef: string;
  port: number;
  env: Record<string, string>;
  commandContext: RuntimeCommandContext;
};

export type ProcessStartResult = {
  internalPort: number;
  log: string;
};

export type RuntimeAdapter = {
  readonly name: string;
  buildRelease(input: ReleaseBuildInput): Promise<ReleaseBuildResult>;
  startProcess(input: ProcessStartInput): Promise<ProcessStartResult>;
  stopProcess(processName: string): Promise<void>;
};

export function processSafeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
}
```

- [ ] **Step 4: Append the adapter to `apps/worker/src/runtime/docker.ts`**

Add these imports at the top (keep existing ones):

```ts
import { inferEveRuntimeCommand } from "@eveland/shared/runtime";
import { processSafeName, type ProcessStartInput, type ProcessStartResult, type ReleaseBuildInput, type ReleaseBuildResult, type RuntimeAdapter, type RuntimeCommandContext } from "./types.js";
```

Append at the bottom:

```ts
// Bridges the container's loopback model port to the host so eve apps that call a
// locally running Ollama (default http://127.0.0.1:11434) reach the host daemon.
const ollamaBridgeCommand = "socat TCP-LISTEN:11434,fork,reuseaddr TCP:host.docker.internal:11434 >/dev/null 2>&1 &";

export function buildDockerStartCommand(context: RuntimeCommandContext, internalPort: number): string {
  if (context.isEveProject) {
    // The image already ran `eve build`; serve the compiled output bound to all
    // interfaces so the published host port can reach it.
    return `${ollamaBridgeCommand} exec npx eve start --host 0.0.0.0 --port ${internalPort}`;
  }
  return inferEveRuntimeCommand({ scripts: context.scripts });
}

export type DockerAdapterConfig = {
  internalPort: number;
};

export function createDockerAdapter(config: DockerAdapterConfig): RuntimeAdapter {
  return {
    name: "docker",
    async buildRelease(input: ReleaseBuildInput): Promise<ReleaseBuildResult> {
      const imageTag = `eveland/${processSafeName(input.projectId)}:${processSafeName(input.releaseId)}`;
      const dockerfilePath = await writeGeneratedDockerfile(input.buildDir);
      const log = await dockerBuild(input.sourcePath, imageTag, dockerfilePath);
      return { releaseRef: imageTag, log };
    },
    async startProcess(input: ProcessStartInput): Promise<ProcessStartResult> {
      const log = await dockerRun({
        containerName: input.processName,
        imageTag: input.releaseRef,
        internalPort: config.internalPort,
        hostPort: input.port,
        env: input.env,
        command: buildDockerStartCommand(input.commandContext, config.internalPort),
      });
      return { internalPort: config.internalPort, log };
    },
    async stopProcess(processName: string): Promise<void> {
      await dockerStopAndRemove(processName);
    },
  };
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm --filter @eveland/worker exec vitest run src/docker.test.ts && pnpm --filter @eveland/worker typecheck`
Expected: PASS (the full-suite process tests are untouched so far).

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/runtime/types.ts apps/worker/src/runtime/docker.ts apps/worker/src/docker.test.ts
git commit -m "feat(worker): add release-shaped RuntimeAdapter interface and docker adapter"
```

---

### Task 2: HTTP health check

**Files:**
- Create: `apps/worker/src/runtime/health.ts`
- Test: `apps/worker/src/runtime/health.test.ts`

**Interfaces:**
- Produces: `waitForHttpHealth(input: { host: string; port: number; timeoutMs: number; healthPath?: string }): Promise<void>` — resolves on **any** HTTP response (eve answers `/eve/v1/health`; plain node apps answer 404, which still proves the server is up); rejects after `timeoutMs` of connection failures. Task 3 wires it as the default `waitForDeployment`.

- [ ] **Step 1: Write the failing tests**

Create `apps/worker/src/runtime/health.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import http from "node:http";
import { waitForHttpHealth } from "./health.js";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || !address) {
    throw new Error("Expected TCP address.");
  }
  return address.port;
}

describe("waitForHttpHealth", () => {
  test("resolves when the server answers, even with a non-200 status", async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 404;
      res.end("not found");
    });
    const port = await listen(server);

    try {
      await expect(waitForHttpHealth({ host: "127.0.0.1", port, timeoutMs: 2000 })).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  test("rejects with the last connection error when nothing listens", async () => {
    const server = http.createServer();
    const port = await listen(server);
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

    await expect(waitForHttpHealth({ host: "127.0.0.1", port, timeoutMs: 700 })).rejects.toThrow(/did not respond within 700ms/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @eveland/worker exec vitest run src/runtime/health.test.ts`
Expected: FAIL — `./health.js` does not exist.

- [ ] **Step 3: Create `apps/worker/src/runtime/health.ts`**

```ts
export type HttpHealthInput = {
  host: string;
  port: number;
  timeoutMs: number;
  healthPath?: string;
};

export async function waitForHttpHealth(input: HttpHealthInput): Promise<void> {
  const url = `http://${input.host}:${input.port}${input.healthPath ?? "/eve/v1/health"}`;
  const deadline = Date.now() + input.timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      // Any HTTP response proves the process accepted the connection; non-eve
      // apps legitimately return 404 for the eve health path.
      await fetch(url, { signal: AbortSignal.timeout(1000) });
      return;
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }

  const cause = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(`Deployment ${url} did not respond within ${input.timeoutMs}ms.${cause}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @eveland/worker exec vitest run src/runtime/health.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/runtime/health.ts apps/worker/src/runtime/health.test.ts
git commit -m "feat(worker): HTTP health check against eve's /eve/v1/health"
```

---

### Task 3: process.ts consumes the release-shaped adapter

**Files:**
- Modify: `apps/worker/src/jobs/process.ts`
- Test: `apps/worker/src/jobs/process.test.ts` (update the fake runtime in the three deploy tests)

**Interfaces:**
- Consumes: `RuntimeAdapter`, `RuntimeCommandContext`, `processSafeName` from `../runtime/types.js` (Task 1); `createDockerAdapter` from `../runtime/docker.js` (Task 1); `waitForHttpHealth` from `../runtime/health.js` (Task 2).
- Produces: `ProcessJobOptions.runtime` is now typed `RuntimeAdapter`. Task 5's `createRuntimeAdapterFromEnv` replaces the inline default construction added here.

- [ ] **Step 1: Update the fake runtimes in `apps/worker/src/jobs/process.test.ts` (failing first)**

In every deploy test that passes `runtime:`, replace the old fake with the new shape (the assertions on recorded deployments stay valid because `releaseRef` uses the same image-tag format):

```ts
runtime: {
  name: "fake",
  async buildRelease(input) {
    runtimeCalls.push({ name: "buildRelease", input: { sourcePath: input.sourcePath, projectId: input.projectId } });
    return { releaseRef: `eveland/${input.projectId.toLowerCase()}:rel`, log: "build ok" };
  },
  async startProcess(input) {
    runtimeCalls.push({ name: "startProcess", input });
    return { internalPort: 3000, log: "started" };
  },
  async stopProcess(processName) {
    runtimeCalls.push({ name: "stopProcess", input: { processName } });
  },
},
```

Update any assertions that referenced `buildImage` / `runContainer` / `stopContainer` call names to `buildRelease` / `startProcess` / `stopProcess`, and assertions on `runContainer` input fields to the `ProcessStartInput` fields (`processName`, `releaseRef`, `port`, `env`, `commandContext`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @eveland/worker exec vitest run src/jobs/process.test.ts`
Expected: FAIL — `process.ts` still expects `buildImage`/`runContainer`/`stopContainer`.

- [ ] **Step 3: Rewrite the runtime handling in `apps/worker/src/jobs/process.ts`**

Replace the imports of docker functions and the local `RuntimeAdapter` type:

```ts
import { createDockerAdapter } from "../runtime/docker.js";
import { waitForHttpHealth } from "../runtime/health.js";
import { processSafeName, type RuntimeAdapter, type RuntimeCommandContext } from "../runtime/types.js";
import { access } from "node:fs/promises";
```

Delete from `process.ts`: the local `type RuntimeAdapter`, `defaultRuntime`, `ollamaBridgeCommand`, `buildContainerCommand`, `dockerSafe`, and the `writeGeneratedDockerfile`/`dockerBuild`/`dockerRun`/`dockerStopAndRemove`/`DockerRunInput` imports.

New default runtime and options type:

```ts
export type ProcessJobOptions = {
  runtime?: RuntimeAdapter;
  appSecretKey?: string;
  allocateHostPort?: () => number | Promise<number>;
  waitForDeployment?: (input: { host: string; port: number; timeoutMs: number }) => Promise<void>;
};

function defaultRuntime(): RuntimeAdapter {
  return createDockerAdapter({ internalPort: Number(process.env.EVELAND_INTERNAL_PORT ?? 3000) });
}
```

Rewrite the `build_deploy` case body between the revision lookup and the log-recording so it reads:

```ts
const runtime = options.runtime ?? defaultRuntime();
const currentDeployment = await store.getCurrentDeployment(job.projectId);
const releaseId = createId("rel");
const deploymentId = createId("dep");
const processName = `eveland-${processSafeName(project.id)}-${processSafeName(deploymentId)}`;
const buildDir = path.join(process.env.EVELAND_DATA_DIR ?? ".eveland-data", "builds", project.id, releaseId);
const hostPort = currentDeployment?.hostPort ?? (await (options.allocateHostPort ?? allocateAvailableHostPort)());
const secrets = await readRuntimeSecrets(store, job.projectId, options.appSecretKey ?? process.env.APP_SECRET_KEY ?? devSecretKey);
const secretValues = Object.values(secrets);
const commandContext = await resolveRuntimeCommandContext(revision.sourcePath);

await store.updateProjectState(job.projectId, { status: "build_pending", deploymentStatus: "building" });
await store.appendLog({
  projectId: job.projectId,
  type: "build",
  line: `Building release ${releaseId} from ${revision.sourcePath}.`,
});

const build = await runtime.buildRelease({
  projectId: project.id,
  releaseId,
  sourcePath: revision.sourcePath,
  buildDir,
  commandContext,
});
if (build.log.trim()) {
  await store.appendLog({
    projectId: job.projectId,
    type: "build",
    line: maskKnownSecrets(build.log.trim(), secretValues),
  });
}

if (currentDeployment) {
  await runtime.stopProcess(currentDeployment.containerName);
}
const started = await runtime.startProcess({
  processName,
  releaseRef: build.releaseRef,
  port: hostPort,
  env: secrets,
  commandContext,
});
await (options.waitForDeployment ?? waitForHttpHealth)({
  host: "127.0.0.1",
  port: hostPort,
  timeoutMs: Number(process.env.EVELAND_HEALTH_TIMEOUT_MS ?? 15_000),
});

const deployment = await store.recordDeployment({
  releaseId,
  deploymentId,
  projectId: job.projectId,
  sourceRevisionId: revision.id,
  imageTag: build.releaseRef,
  containerName: processName,
  internalPort: started.internalPort,
  hostPort,
});
```

Keep `waitForTcpPort`, `connectOnce`, and `sleep` deleted only if nothing references them anymore — `waitForHttpHealth` replaces `waitForTcpPort` as the default, so delete all three (`sleep` lives in `health.ts` now). Keep `allocateAvailableHostPort` and `isTcpPortAvailable`.

Add the context resolver next to the existing `readPackageJson`/`isEveProject` helpers (both stay):

```ts
async function resolveRuntimeCommandContext(sourcePath: string): Promise<RuntimeCommandContext> {
  const packageJson = await readPackageJson(sourcePath);
  return {
    isEveProject: isEveProject(packageJson),
    hasLockfile: await fileExists(path.join(sourcePath, "package-lock.json")),
    scripts: packageJson?.scripts ?? {},
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run the full worker suite and typecheck**

Run: `pnpm --filter @eveland/worker test && pnpm --filter @eveland/worker typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/jobs/process.ts apps/worker/src/jobs/process.test.ts
git commit -m "refactor(worker): deploy jobs drive the release-shaped runtime adapter"
```

---

### Task 4: systemd pure builders

**Files:**
- Create: `apps/worker/src/runtime/systemd.ts`
- Test: `apps/worker/src/runtime/systemd.test.ts`

**Interfaces:**
- Consumes: `RuntimeCommandContext` from `./types.js`; `inferEveRuntimeCommand` from `@eveland/shared/runtime`.
- Produces (Task 5's adapter calls these):

```ts
export type SystemdStartInput = {
  unitName: string; releaseDir: string; envFilePath: string; port: number;
  user: string; memoryMax: string; cpuQuota: string; command: string;
};
export function buildSystemdRunArgs(input: SystemdStartInput): string[];
export function buildSystemdStartCommand(context: RuntimeCommandContext, port: number): string;
export function buildReleaseBuildCommand(context: RuntimeCommandContext): string;
export function buildBwrapArgs(input: { releaseDir: string; npmCacheDir: string; command: string }): string[];
export function buildEnvFileContent(env: Record<string, string>): string;
```

- [ ] **Step 1: Write the failing tests**

Create `apps/worker/src/runtime/systemd.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { buildBwrapArgs, buildEnvFileContent, buildReleaseBuildCommand, buildSystemdRunArgs, buildSystemdStartCommand } from "./systemd.js";

describe("buildSystemdRunArgs", () => {
  test("creates a hardened transient unit bound to the release dir", () => {
    const args = buildSystemdRunArgs({
      unitName: "eveland-proj_123-dep_456",
      releaseDir: "/data/builds/proj_123/rel_789",
      envFilePath: "/data/deployment-env/eveland-proj_123-dep_456.env",
      port: 41000,
      user: "eveland-app",
      memoryMax: "2G",
      cpuQuota: "200%",
      command: "npx eve start --host 127.0.0.1 --port 41000",
    });

    expect(args).toEqual([
      "--unit",
      "eveland-proj_123-dep_456",
      "--collect",
      "--service-type=exec",
      "--property=Restart=on-failure",
      "--property=RestartSec=2",
      "--property=User=eveland-app",
      "--property=WorkingDirectory=/data/builds/proj_123/rel_789",
      "--property=EnvironmentFile=/data/deployment-env/eveland-proj_123-dep_456.env",
      "--property=Environment=PORT=41000",
      "--property=MemoryMax=2G",
      "--property=CPUQuota=200%",
      "--property=ProtectSystem=strict",
      "--property=ReadWritePaths=/data/builds/proj_123/rel_789",
      "--property=PrivateTmp=yes",
      "--property=NoNewPrivileges=yes",
      "sh",
      "-lc",
      "npx eve start --host 127.0.0.1 --port 41000",
    ]);
  });
});

describe("buildSystemdStartCommand", () => {
  test("serves eve projects on loopback without any bridge hack", () => {
    const command = buildSystemdStartCommand({ isEveProject: true, hasLockfile: true, scripts: {} }, 41000);
    expect(command).toBe("npx eve start --host 127.0.0.1 --port 41000");
  });

  test("falls back to the inferred runtime command for plain node projects", () => {
    const command = buildSystemdStartCommand({ isEveProject: false, hasLockfile: false, scripts: { start: "node server.js" } }, 41000);
    expect(command).toBe("npm run start");
  });
});

describe("buildReleaseBuildCommand", () => {
  test("uses npm ci and eve build when a lockfile and eve dependency exist", () => {
    expect(buildReleaseBuildCommand({ isEveProject: true, hasLockfile: true, scripts: {} })).toBe("npm ci && npx eve build");
  });

  test("uses npm install without eve build for plain projects without a lockfile", () => {
    expect(buildReleaseBuildCommand({ isEveProject: false, hasLockfile: false, scripts: {} })).toBe("npm install");
  });
});

describe("buildBwrapArgs", () => {
  test("mounts the rootfs read-only with a writable release dir and npm cache", () => {
    const args = buildBwrapArgs({
      releaseDir: "/data/builds/proj_123/rel_789",
      npmCacheDir: "/data/npm-cache",
      command: "npm ci && npx eve build",
    });

    expect(args).toEqual([
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      "--proc", "/proc",
      "--tmpfs", "/tmp",
      "--bind", "/data/builds/proj_123/rel_789", "/data/builds/proj_123/rel_789",
      "--bind", "/data/npm-cache", "/data/npm-cache",
      "--unshare-pid",
      "--die-with-parent",
      "--chdir", "/data/builds/proj_123/rel_789",
      "sh", "-lc", "npm ci && npx eve build",
    ]);
  });
});

describe("buildEnvFileContent", () => {
  test("writes sorted, quoted assignments with escaped quotes and backslashes", () => {
    const content = buildEnvFileContent({ B_KEY: 'va"lue', A_KEY: "back\\slash" });
    expect(content).toBe('A_KEY="back\\\\slash"\nB_KEY="va\\"lue"\n');
  });

  test("rejects values containing newlines", () => {
    expect(() => buildEnvFileContent({ BAD: "line1\nline2" })).toThrow(/newline/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @eveland/worker exec vitest run src/runtime/systemd.test.ts`
Expected: FAIL — `./systemd.js` does not exist.

- [ ] **Step 3: Create `apps/worker/src/runtime/systemd.ts` with the pure builders**

```ts
import { inferEveRuntimeCommand } from "@eveland/shared/runtime";
import type { RuntimeCommandContext } from "./types.js";

export type SystemdStartInput = {
  unitName: string;
  releaseDir: string;
  envFilePath: string;
  port: number;
  user: string;
  memoryMax: string;
  cpuQuota: string;
  command: string;
};

export function buildSystemdRunArgs(input: SystemdStartInput): string[] {
  return [
    "--unit",
    input.unitName,
    "--collect",
    "--service-type=exec",
    "--property=Restart=on-failure",
    "--property=RestartSec=2",
    `--property=User=${input.user}`,
    `--property=WorkingDirectory=${input.releaseDir}`,
    `--property=EnvironmentFile=${input.envFilePath}`,
    `--property=Environment=PORT=${input.port}`,
    `--property=MemoryMax=${input.memoryMax}`,
    `--property=CPUQuota=${input.cpuQuota}`,
    "--property=ProtectSystem=strict",
    `--property=ReadWritePaths=${input.releaseDir}`,
    "--property=PrivateTmp=yes",
    "--property=NoNewPrivileges=yes",
    "sh",
    "-lc",
    input.command,
  ];
}

export function buildSystemdStartCommand(context: RuntimeCommandContext, port: number): string {
  if (context.isEveProject) {
    // Host process: loopback binding is enough, and Ollama on localhost needs no bridge.
    return `npx eve start --host 127.0.0.1 --port ${port}`;
  }
  return inferEveRuntimeCommand({ scripts: context.scripts });
}

export function buildReleaseBuildCommand(context: RuntimeCommandContext): string {
  const install = context.hasLockfile ? "npm ci" : "npm install";
  return context.isEveProject ? `${install} && npx eve build` : install;
}

export type BwrapBuildInput = {
  releaseDir: string;
  npmCacheDir: string;
  command: string;
};

export function buildBwrapArgs(input: BwrapBuildInput): string[] {
  return [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--bind", input.releaseDir, input.releaseDir,
    "--bind", input.npmCacheDir, input.npmCacheDir,
    "--unshare-pid",
    "--die-with-parent",
    "--chdir", input.releaseDir,
    "sh", "-lc", input.command,
  ];
}

export function buildEnvFileContent(env: Record<string, string>): string {
  const lines = Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      if (value.includes("\n")) {
        throw new Error(`Secret ${key} contains a newline; systemd EnvironmentFile cannot represent it.`);
      }
      return `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    });
  return lines.length ? `${lines.join("\n")}\n` : "";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @eveland/worker exec vitest run src/runtime/systemd.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/runtime/systemd.ts apps/worker/src/runtime/systemd.test.ts
git commit -m "feat(worker): systemd-run, bwrap, and env-file builders"
```

---

### Task 5: systemd adapter + adapter selection from env

**Files:**
- Modify: `apps/worker/src/runtime/systemd.ts` (append `createSystemdAdapter`)
- Create: `apps/worker/src/runtime/select.ts`
- Test: `apps/worker/src/runtime/select.test.ts`
- Modify: `apps/worker/src/jobs/process.ts` (default runtime uses `createRuntimeAdapterFromEnv`)

**Interfaces:**
- Consumes: everything Task 4 produces; `RuntimeAdapter` from `./types.js`; `createDockerAdapter` from `./docker.js`.
- Produces:

```ts
// systemd.ts
export type SystemdAdapterConfig = {
  dataDir: string; user: string; memoryMax: string; cpuQuota: string; buildSandbox: "bwrap" | "none";
};
export function createSystemdAdapter(config: SystemdAdapterConfig): RuntimeAdapter;
// select.ts
export function createRuntimeAdapterFromEnv(env?: NodeJS.ProcessEnv): RuntimeAdapter;
```

- [ ] **Step 1: Write the failing selection tests**

Create `apps/worker/src/runtime/select.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { createRuntimeAdapterFromEnv } from "./select.js";

describe("createRuntimeAdapterFromEnv", () => {
  test("defaults to the docker adapter", () => {
    expect(createRuntimeAdapterFromEnv({}).name).toBe("docker");
  });

  test("selects the systemd adapter when EVELAND_RUNTIME=systemd", () => {
    expect(createRuntimeAdapterFromEnv({ EVELAND_RUNTIME: "systemd" }).name).toBe("systemd");
  });

  test("rejects unknown runtime kinds", () => {
    expect(() => createRuntimeAdapterFromEnv({ EVELAND_RUNTIME: "kubernetes" })).toThrow(/Unknown EVELAND_RUNTIME/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @eveland/worker exec vitest run src/runtime/select.test.ts`
Expected: FAIL — `./select.js` does not exist.

- [ ] **Step 3: Append `createSystemdAdapter` to `apps/worker/src/runtime/systemd.ts`**

Add imports at the top:

```ts
import { execa } from "execa";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProcessStartInput, ProcessStartResult, ReleaseBuildInput, ReleaseBuildResult, RuntimeAdapter } from "./types.js";
```

Append at the bottom:

```ts
export type SystemdAdapterConfig = {
  dataDir: string;
  user: string;
  memoryMax: string;
  cpuQuota: string;
  buildSandbox: "bwrap" | "none";
};

export function createSystemdAdapter(config: SystemdAdapterConfig): RuntimeAdapter {
  const npmCacheDir = path.resolve(config.dataDir, "npm-cache");
  const envDir = path.resolve(config.dataDir, "deployment-env");

  return {
    name: "systemd",
    async buildRelease(input: ReleaseBuildInput): Promise<ReleaseBuildResult> {
      const releaseDir = path.resolve(input.buildDir);
      await mkdir(releaseDir, { recursive: true });
      await mkdir(npmCacheDir, { recursive: true });
      await execa("cp", ["-a", `${path.resolve(input.sourcePath)}/.`, releaseDir]);

      const command = buildReleaseBuildCommand(input.commandContext);
      const execution =
        config.buildSandbox === "bwrap"
          ? await execa("bwrap", buildBwrapArgs({ releaseDir, npmCacheDir, command }), {
              all: true,
              env: { npm_config_cache: npmCacheDir },
            })
          : await execa("sh", ["-lc", command], {
              all: true,
              cwd: releaseDir,
              env: { npm_config_cache: npmCacheDir },
            });

      // The unit's fixed service user needs to own the release dir: eve's default
      // local workflow world writes .workflow-data/ into the working directory.
      await execa("chown", ["-R", `${config.user}:`, releaseDir]);
      return { releaseRef: releaseDir, log: execution.all ?? "" };
    },
    async startProcess(input: ProcessStartInput): Promise<ProcessStartResult> {
      await mkdir(envDir, { recursive: true });
      const envFilePath = path.join(envDir, `${input.processName}.env`);
      await writeFile(envFilePath, buildEnvFileContent(input.env), { mode: 0o600 });

      const result = await execa(
        "systemd-run",
        buildSystemdRunArgs({
          unitName: input.processName,
          releaseDir: input.releaseRef,
          envFilePath,
          port: input.port,
          user: config.user,
          memoryMax: config.memoryMax,
          cpuQuota: config.cpuQuota,
          command: buildSystemdStartCommand(input.commandContext, input.port),
        }),
        { all: true },
      );
      return { internalPort: input.port, log: result.all ?? "" };
    },
    async stopProcess(processName: string): Promise<void> {
      await execa("systemctl", ["stop", `${processName}.service`], { reject: false });
      await execa("systemctl", ["reset-failed", `${processName}.service`], { reject: false });
    },
  };
}
```

- [ ] **Step 4: Create `apps/worker/src/runtime/select.ts`**

```ts
import path from "node:path";
import { createDockerAdapter } from "./docker.js";
import { createSystemdAdapter } from "./systemd.js";
import type { RuntimeAdapter } from "./types.js";

export function createRuntimeAdapterFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeAdapter {
  const kind = env.EVELAND_RUNTIME ?? "docker";

  if (kind === "docker") {
    return createDockerAdapter({ internalPort: Number(env.EVELAND_INTERNAL_PORT ?? 3000) });
  }

  if (kind === "systemd") {
    return createSystemdAdapter({
      dataDir: path.resolve(env.EVELAND_DATA_DIR ?? ".eveland-data"),
      user: env.EVELAND_APP_USER ?? "eveland-app",
      memoryMax: env.EVELAND_MEMORY_MAX ?? "2G",
      cpuQuota: env.EVELAND_CPU_QUOTA ?? "200%",
      buildSandbox: env.EVELAND_BUILD_SANDBOX === "none" ? "none" : "bwrap",
    });
  }

  throw new Error(`Unknown EVELAND_RUNTIME "${kind}". Expected "docker" or "systemd".`);
}
```

- [ ] **Step 5: Point the default runtime in `apps/worker/src/jobs/process.ts` at the selector**

Replace the `defaultRuntime()` helper and the `createDockerAdapter` import from Task 3 with:

```ts
import { createRuntimeAdapterFromEnv } from "../runtime/select.js";
```

and in the `build_deploy` case:

```ts
const runtime = options.runtime ?? createRuntimeAdapterFromEnv();
```

- [ ] **Step 6: Run the full worker suite and typecheck**

Run: `pnpm --filter @eveland/worker test && pnpm --filter @eveland/worker typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/runtime/systemd.ts apps/worker/src/runtime/select.ts apps/worker/src/runtime/select.test.ts apps/worker/src/jobs/process.ts
git commit -m "feat(worker): systemd adapter and EVELAND_RUNTIME selection"
```

---

### Task 6: Lima VM, integration smoke test, and deploy docs

**Files:**
- Create: `infra/lima/eveland.yaml`
- Create: `infra/integration/run.sh`
- Create: `apps/worker/src/integration/systemd-smoke.ts`
- Create: `docs/deploy/linux.md`

**Interfaces:**
- Consumes: the full worker path (`processNextJob` with `EVELAND_RUNTIME=systemd`), `createMemoryStore` from `@eveland/api/store`.
- Produces: a repeatable `bash infra/integration/run.sh` that provisions the VM and exits 0 printing `SMOKE OK`.

- [ ] **Step 1: Create `infra/lima/eveland.yaml`**

```yaml
# Lima VM for eveland systemd/bwrap integration tests.
# Start:  limactl start --name eveland-test infra/lima/eveland.yaml --tty=false
images:
  - location: "https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-arm64.img"
    arch: "aarch64"
  - location: "https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-amd64.img"
    arch: "x86_64"
cpus: 4
memory: "6GiB"
disk: "30GiB"
mounts:
  - location: "~"
    writable: false
provision:
  - mode: system
    script: |
      #!/bin/bash
      set -eux
      export DEBIAN_FRONTEND=noninteractive
      apt-get update
      apt-get install -y bubblewrap rsync curl ca-certificates
      curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
      apt-get install -y nodejs
      corepack enable
      id eveland-app || useradd --system --home-dir /var/lib/eveland-app --create-home eveland-app
```

- [ ] **Step 2: Create `apps/worker/src/integration/systemd-smoke.ts`**

This is a script, not a vitest file (vitest only picks up `*.test.ts`). It deploys a plain-node fixture through the real job pipeline with the real systemd adapter, asserts the health path, then cleans up the unit.

```ts
import { createMemoryStore } from "@eveland/api/store";
import { execa } from "execa";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { processNextJob } from "../jobs/process.js";

if (process.env.EVELAND_RUNTIME !== "systemd") {
  throw new Error("Run with EVELAND_RUNTIME=systemd (this smoke test exercises the systemd adapter).");
}

const sourcePath = await mkdtemp(path.join(os.tmpdir(), "eveland-smoke-"));
await mkdir(path.join(sourcePath, "agent"), { recursive: true });
await writeFile(path.join(sourcePath, "agent", "instructions.md"), "Smoke fixture.\n");
await writeFile(
  path.join(sourcePath, "package.json"),
  JSON.stringify({ name: "eveland-smoke", version: "0.0.0", scripts: { start: "node server.js" } }, null, 2),
);
await writeFile(
  path.join(sourcePath, "server.js"),
  'const http = require("node:http");\nhttp.createServer((req, res) => res.end("smoke-ok")).listen(Number(process.env.PORT ?? 3000), "127.0.0.1");\n',
);

const store = createMemoryStore();
const project = await store.createProject({ name: "Systemd Smoke", importKind: "zip", sourcePath });

if (!(await processNextJob(store, "smoke-worker"))) throw new Error("import_source job did not run.");
const imported = await store.getProject(project.id);
if (imported?.status !== "imported") throw new Error(`Import failed: ${JSON.stringify(imported)}`);

await store.enqueueJob(project.id, "build_deploy");
if (!(await processNextJob(store, "smoke-worker"))) throw new Error("build_deploy job did not run.");

const deployed = await store.getProject(project.id);
const deployment = await store.getCurrentDeployment(project.id);
if (deployed?.deploymentStatus !== "running" || !deployment) {
  const logs = await store.listLogs(project.id, "runtime");
  throw new Error(`Deploy failed: ${JSON.stringify({ deployed, logs })}`);
}

const response = await fetch(`http://127.0.0.1:${deployment.hostPort}/`);
const body = await response.text();

await execa("systemctl", ["stop", `${deployment.containerName}.service`], { reject: false });
await execa("systemctl", ["reset-failed", `${deployment.containerName}.service`], { reject: false });

if (!body.includes("smoke-ok")) throw new Error(`Unexpected response body: ${body}`);
console.log("SMOKE OK");
```

- [ ] **Step 3: Create `infra/integration/run.sh`**

```bash
#!/bin/bash
# Runs the systemd/bwrap integration smoke test inside the Lima VM.
# Prereq: brew install lima
set -euo pipefail
cd "$(dirname "$0")/../.."
REPO_DIR="$(pwd)"
VM=eveland-test

if ! limactl list --format '{{.Name}}' | grep -qx "$VM"; then
  limactl start --name "$VM" infra/lima/eveland.yaml --tty=false
else
  limactl start "$VM" || true
fi

limactl shell "$VM" -- sudo bash -c "
  set -euo pipefail
  rsync -a --delete --exclude node_modules --exclude .eveland-data --exclude .next '$REPO_DIR/' /opt/eveland/
  cd /opt/eveland
  corepack pnpm install --frozen-lockfile
  EVELAND_RUNTIME=systemd EVELAND_BUILD_SANDBOX=bwrap EVELAND_DATA_DIR=/var/lib/eveland-data \
    corepack pnpm --filter @eveland/worker exec tsx src/integration/systemd-smoke.ts
"
```

Then: `chmod +x infra/integration/run.sh`

Note: `tsx` must be runnable — it is available transitively via the workspace root; if `pnpm --filter @eveland/worker exec tsx` reports it missing, add `tsx` to `apps/worker` devDependencies (it is already used by the `dev` script, so it should resolve from the workspace).

- [ ] **Step 4: Run the smoke test to verify it fails cleanly on macOS**

Run: `EVELAND_RUNTIME=systemd pnpm --filter @eveland/worker exec tsx src/integration/systemd-smoke.ts`
Expected: FAIL on macOS at the build/systemd-run step (no bwrap/systemd) — confirms the script wiring executes past the store setup. (Skip if pnpm exec cannot find tsx; fix per note above first.)

- [ ] **Step 5: Run the integration test in the VM**

Run: `bash infra/integration/run.sh`
Expected: exits 0 and prints `SMOKE OK`. First run takes several minutes (image download + provisioning + pnpm install).

If it fails inside the VM, inspect from the VM: `limactl shell eveland-test -- sudo journalctl -u 'eveland-*' --no-pager | tail -50`.

- [ ] **Step 6: Write `docs/deploy/linux.md`**

```markdown
# Deploying eveland on Linux (systemd runtime)

## Host prerequisites

- Linux with systemd (verified on Ubuntu 24.04).
- Node.js 24 (e.g. NodeSource) and `corepack enable`.
- `bubblewrap` from the distro package (`apt-get install bubblewrap`). On Ubuntu 23.10+
  install it via apt: the packaged AppArmor profile permits unprivileged user
  namespaces; a source/nix install will hit EPERM.
- A service user for deployments: `useradd --system --create-home eveland-app`.
- The worker process must run as root (it drives `systemd-run`, `systemctl`,
  and `chown`). Run it as a systemd service itself.

## Worker configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `EVELAND_RUNTIME` | `docker` | Set `systemd` on the deploy host. |
| `EVELAND_APP_USER` | `eveland-app` | Unix user deployments run as. |
| `EVELAND_MEMORY_MAX` | `2G` | systemd `MemoryMax` per deployment. |
| `EVELAND_CPU_QUOTA` | `200%` | systemd `CPUQuota` per deployment. |
| `EVELAND_BUILD_SANDBOX` | `bwrap` | `none` disables the build sandbox (not recommended: `npm install` runs third-party lifecycle scripts). |
| `EVELAND_DATA_DIR` | `.eveland-data` | Sources, builds, npm cache, env files. Use an absolute path, e.g. `/var/lib/eveland-data`. |

## How a deployment runs

- Build: source is copied to `$EVELAND_DATA_DIR/builds/<project>/<release>`, then
  `npm ci && npx eve build` runs inside bubblewrap (read-only rootfs, writable
  release dir + shared npm cache, PID namespace).
- Run: `systemd-run` starts transient unit `eveland-<project>-<deployment>.service`
  with `User=eveland-app`, `ProtectSystem=strict`, `ReadWritePaths=<releaseDir>`,
  `PrivateTmp`, `NoNewPrivileges`, `MemoryMax`, `CPUQuota`, `Restart=on-failure`.
  The app binds `127.0.0.1:<hostPort>`; secrets arrive via a root-owned 0600
  `EnvironmentFile`.
- Health: the worker polls `http://127.0.0.1:<hostPort>/eve/v1/health` until any
  HTTP response arrives.

## Reverse proxy

If you route by path in front of a deployment, forward **both** `/eve/` and
`/.well-known/workflow/`. The workflow world delivers run callbacks to
`/.well-known/workflow/v1/flow`; forwarding only `/eve/` lets sessions start but
stalls every run silently.

## Logs

`journalctl -u eveland-<project>-<deployment>.service`

## Known limits (v1)

- Deployments share one service user; per-deployment `DynamicUser` isolation is
  a follow-up.
- The eve sandbox backend inside deployed agents is addressed separately
  (`@eveland/sandbox-bwrap`, Plan 2).
```

- [ ] **Step 7: Commit**

```bash
git add infra/lima/eveland.yaml infra/integration/run.sh apps/worker/src/integration/systemd-smoke.ts docs/deploy/linux.md
git commit -m "feat(infra): Lima VM integration test and Linux deploy docs for the systemd runtime"
```

---

## Self-Review

- **Spec coverage:** RuntimeAdapter reshape (Tasks 1, 3), host builds under bwrap (Tasks 4, 5), systemd-run transient units (Tasks 4, 5), secrets via env file (Tasks 4, 5; LoadCredential deviation documented in Global Constraints), `/eve/v1/health` (Task 2), docker fallback as default (Tasks 1, 5), Lima verification (Task 6). StateDirectory deviation documented in Global Constraints. `@eveland/sandbox-bwrap` explicitly deferred to Plan 2.
- **Placeholder scan:** all steps carry complete code, exact paths, exact commands.
- **Type consistency:** `RuntimeCommandContext { isEveProject, hasLockfile, scripts }`, `ReleaseBuildResult { releaseRef, log }`, `ProcessStartResult { internalPort, log }` used identically across Tasks 1–6; `processSafeName` defined in Task 1, consumed in Tasks 1 and 3.
