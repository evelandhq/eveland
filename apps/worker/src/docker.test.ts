import { describe, expect, test, vi } from "vitest";
import { execa } from "execa";
import { access, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildDockerBuildArgs,
  buildDockerRunArgs,
  buildDockerSandboxVerifyArgs,
  buildDockerStartCommand,
  createAgentTelemetryNetworkReconciler,
  createDockerAdapter,
  ensureAgentTelemetryNetwork,
  isBenignDockerStopFailure,
  listOrphanAgentTelemetryNetworks,
  removeOrphanAgentTelemetryNetwork,
  resolveAgentTelemetryNetworkName,
  verifyDockerSandbox,
  writeGeneratedDockerfile,
} from "./runtime/docker.js";
import { injectSandboxModules } from "./runtime/sandbox-inject.js";
import { processSafeName } from "./runtime/types.js";

// Module-scoped: every test in this file runs against the mocked execa. This is safe
// because every other suite here exercises pure functions (buildDockerBuildArgs,
// buildDockerRunArgs, writeGeneratedDockerfile — which only writes a file, no execa).
vi.mock("execa", () => ({
  execa: vi.fn(async () => ({ all: "" })),
}));

vi.mock("@eveland/agent-scheduler", () => ({
  injectSchedulerAdapter: vi.fn().mockResolvedValue({
    eveVersion: "0.25.1",
    channelPath: "agent/channels/eveland-scheduler.ts",
    definitions: [],
  }),
}));

vi.mock("./runtime/sandbox-inject.js", () => ({
  injectSandboxModules: vi.fn(async () => ({ generated: ["agent/sandbox.js"], replaced: [] })),
}));

const dockerAdapterConfig = {
  internalPort: 3000,
  backendDistDir: () => "/opt/eveland/sandbox-bwrap",
};

test("the root dev script builds the vendored sandbox backend before starting workspace dev", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };
  expect(manifest.scripts.dev).toMatch(/^pnpm --filter @eveland\/sandbox-bwrap build && /);
});

test("the Worker dev process restarts when the shared .env changes", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    scripts: Record<string, string>;
  };

  expect(manifest.scripts.dev).toContain("--include ../../.env");
});

describe("buildDockerBuildArgs", () => {
  test("builds with a generated Dockerfile outside the source tree", () => {
    const args = buildDockerBuildArgs({
      contextDir: "/workspace/source",
      dockerfilePath: "/workspace/builds/Dockerfile",
      imageTag: "eveland/proj_123:rel_456",
    });

    expect(args).toEqual(["build", "--file", "/workspace/builds/Dockerfile", "--tag", "eveland/proj_123:rel_456", "/workspace/source"]);
  });
});

describe("Docker sandbox self-check", () => {
  test("runs the generated TypeScript probe under the same bwrap permissions as a deployment", async () => {
    expect(buildDockerSandboxVerifyArgs("eveland/proj_123:rel_456")).toEqual([
      "run",
      "--rm",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "SYS_ADMIN",
      "--cap-add",
      "NET_ADMIN",
      "--security-opt",
      "no-new-privileges",
      "--security-opt",
      "seccomp=unconfined",
      "--network",
      "none",
      "--tmpfs",
      "/tmp",
      "--env",
      "EVELAND_SANDBOX_CACHE_DIR=/tmp",
      "eveland/proj_123:rel_456",
      "node",
      "/app/.eveland/verify-sandbox.mjs",
    ]);

    vi.mocked(execa).mockResolvedValueOnce({ exitCode: 0, all: "SANDBOX VERIFY OK" } as never);
    await expect(verifyDockerSandbox("eveland/proj_123:rel_456")).resolves.toBeUndefined();
  });

  test("rejects a release when the Docker sandbox probe cannot execute", async () => {
    vi.mocked(execa).mockResolvedValueOnce({ exitCode: 1, all: "bwrap: Operation not permitted" } as never);
    await expect(verifyDockerSandbox("eveland/proj_123:rel_456")).rejects.toThrow(/Operation not permitted/);
  });
});

describe("buildDockerRunArgs", () => {
  test("creates a local-only docker run command with env injection and runtime command", () => {
    const args = buildDockerRunArgs({
      containerName: "eveland-proj_123",
      imageTag: "eveland/proj_123:rel_456",
      internalPort: 3000,
      hostPort: 43123,
      sandboxEnabled: true,
      sandboxCacheDir: "/host/eveland/sandbox/proj_123",
      observabilityPolicyDir:
        "/host/eveland/observability/proj_123/dep_456",
      env: { OPENAI_API_KEY: "sk-test-123456" },
      command: "npm run start",
    });

    expect(args).toEqual([
      "run",
      "--detach",
      "--name",
      "eveland-proj_123",
      "--restart",
      "unless-stopped",
      "--network",
      resolveAgentTelemetryNetworkName("eveland-proj_123"),
      "--cap-drop",
      "ALL",
      "--cap-add",
      "SYS_ADMIN",
      "--cap-add",
      "NET_ADMIN",
      "--security-opt",
      "no-new-privileges",
      "--security-opt",
      "seccomp=unconfined",
      "--add-host",
      "host.docker.internal:host-gateway",
      "--publish",
      "127.0.0.1:43123:3000",
      "--volume",
      "/host/eveland/observability/proj_123/dep_456:/run/eveland/observability:ro",
      "--volume",
      "/host/eveland/sandbox/proj_123:/var/lib/eveland-sandbox",
      "--env",
      "EVELAND_SANDBOX_CACHE_DIR=/var/lib/eveland-sandbox",
      "--env",
      "EVELAND_SANDBOX_TEMPLATE_REVISION=eveland/proj_123:rel_456",
      "--env",
      "OPENAI_API_KEY=sk-test-123456",
      "eveland/proj_123:rel_456",
      "sh",
      "-lc",
      "npm run start",
    ]);
    expect(args).toContain("EVELAND_SANDBOX_TEMPLATE_REVISION=eveland/proj_123:rel_456");
  });

  test("does not elevate or mount a sandbox cache for plain Node deployments", () => {
    const args = buildDockerRunArgs({
      containerName: "eveland-plain-node",
      imageTag: "eveland/plain:rel_1",
      internalPort: 3000,
      hostPort: 43124,
      sandboxEnabled: false,
      sandboxCacheDir: "/host/eveland/sandbox/plain",
      observabilityPolicyDir:
        "/host/eveland/observability/plain/dep_1",
      env: {},
      command: "npm start",
    });

    expect(args).not.toContain("SYS_ADMIN");
    expect(args).not.toContain("NET_ADMIN");
    expect(args).not.toContain("seccomp=unconfined");
    expect(args).not.toContain("/host/eveland/sandbox/plain:/var/lib/eveland-sandbox");
    expect(args).not.toContain("EVELAND_SANDBOX_CACHE_DIR=/var/lib/eveland-sandbox");
    expect(args.some((arg) => arg.startsWith("EVELAND_SANDBOX_TEMPLATE_REVISION="))).toBe(false);
  });

  test("does not let project env override the platform template revision", () => {
    const args = buildDockerRunArgs({
      containerName: "eveland-proj_123",
      imageTag: "eveland/proj_123:rel_platform",
      internalPort: 3000,
      hostPort: 43125,
      sandboxEnabled: true,
      sandboxCacheDir: "/host/eveland/sandbox/proj_123",
      observabilityPolicyDir:
        "/host/eveland/observability/proj_123/dep_456",
      env: { EVELAND_SANDBOX_TEMPLATE_REVISION: "project-controlled" },
      command: "npm run start",
    });

    expect(args.filter((arg) => arg.startsWith("EVELAND_SANDBOX_TEMPLATE_REVISION="))).toEqual([
      "EVELAND_SANDBOX_TEMPLATE_REVISION=eveland/proj_123:rel_platform",
    ]);
  });
});

describe("writeGeneratedDockerfile", () => {
  test("creates a Node runtime image definition without modifying source files", async () => {
    const buildDir = await mkdtemp(path.join(os.tmpdir(), "eveland-build-"));
    const dockerfilePath = await writeGeneratedDockerfile(buildDir);
    const contents = await readFile(dockerfilePath, "utf8");

    expect(dockerfilePath).toBe(path.join(buildDir, "Dockerfile"));
    expect(contents).toContain("FROM node:24-alpine");
    expect(contents).toContain(
      "apk add --no-cache bash bubblewrap ca-certificates curl findutils git grep jq py3-pip python3 ripgrep socat unzip zstd",
    );
    expect(contents).toContain("ln -sf /usr/bin/python3 /usr/local/bin/python");
    expect(contents).toContain("ln -sf /usr/bin/pip3 /usr/local/bin/pip");
    expect(contents).toContain("npm install --global pnpm@11.7.0");
    expect(contents).toContain("mkdir -p /workspace");
    expect(contents).toContain(
      "COPY package*.json pnpm-lock.yaml* pnpm-workspace.yaml* .npmrc* ./",
    );
    expect(contents.indexOf("pnpm-workspace.yaml*")).toBeLessThan(
      contents.indexOf("pnpm install --frozen-lockfile"),
    );
    expect(contents).toContain(
      "if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile --config.minimum-release-age=0",
    );
    expect(contents).toContain("COPY . .");
    expect(contents).toContain("npx eve build");
    expect(contents).toContain("EXPOSE 3000");
  });

  test("installs the platform-owned world without changing the project package manifest or lock", async () => {
    const buildDir = await mkdtemp(path.join(os.tmpdir(), "eveland-build-"));
    const dockerfilePath = await writeGeneratedDockerfile(buildDir, {
      packageName: "@workflow/world-postgres",
      packageVersion: "5.0.0-beta.25",
    });
    const contents = await readFile(dockerfilePath, "utf8");

    expect(contents).toContain(
      "npm install --no-save --package-lock=false --ignore-scripts @workflow/world-postgres@5.0.0-beta.25",
    );
    expect(contents.indexOf("npm install --no-save")).toBeLessThan(contents.indexOf("npx eve build"));
  });
});

describe("processSafeName", () => {
  test("lowercases and replaces unsafe characters", () => {
    expect(processSafeName("Proj_ABC/9.x")).toBe("proj_abc-9.x");
  });

  test("never returns a path-traversal segment for dots-only input", () => {
    expect(processSafeName("..")).not.toBe("..");
    expect(processSafeName(".")).not.toBe(".");
    expect(processSafeName("...")).not.toBe("...");
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

describe("createDockerAdapter listProcesses", () => {
  test("lists running containers whose name starts with the prefix", async () => {
    const adapter = createDockerAdapter(dockerAdapterConfig);
    vi.mocked(execa).mockResolvedValueOnce({
      failed: false,
      stdout: "eveland-proj_alpha-dep_one\neveland-proj_beta-dep_two\n",
    } as never);

    await expect(adapter.listProcesses!("eveland-")).resolves.toEqual([
      "eveland-proj_alpha-dep_one",
      "eveland-proj_beta-dep_two",
    ]);
    expect(execa).toHaveBeenLastCalledWith(
      "docker",
      ["ps", "--format", "{{.Names}}", "--filter", "name=^eveland-"],
      expect.objectContaining({ reject: false }),
    );
  });

  test("throws when the docker CLI cannot list containers", async () => {
    const adapter = createDockerAdapter(dockerAdapterConfig);
    vi.mocked(execa).mockResolvedValueOnce({ failed: true, all: "Cannot connect to the Docker daemon" } as never);

    await expect(adapter.listProcesses!("eveland-")).rejects.toThrow(/docker ps/);
  });
});

describe("Agent telemetry network reconciliation", () => {
  test("reattaches managed networks only when the Collector identity changes", async () => {
    vi.mocked(execa).mockClear();
    const processA = "eveland-proj_a-dep_a";
    const processB = "eveland-proj_b-dep_b";
    const networkA = resolveAgentTelemetryNetworkName(processA);
    const networkB = resolveAgentTelemetryNetworkName(processB);
    vi.mocked(execa)
      .mockResolvedValueOnce({
        failed: false,
        stdout: "collector-id-1\n",
      } as never)
      .mockResolvedValueOnce({
        failed: false,
        stdout: `${networkA}\t${processA}\n${networkB}\t${processB}\n`,
      } as never)
      .mockResolvedValueOnce({ failed: false, all: "" } as never)
      .mockResolvedValueOnce({ failed: false, all: "" } as never)
      .mockResolvedValueOnce({
        failed: true,
        all: `Error: No such container: ${processB}`,
      } as never)
      .mockResolvedValueOnce({
        failed: false,
        stdout: "collector-id-1\n",
      } as never)
      .mockResolvedValueOnce({
        failed: false,
        stdout: "collector-id-2\n",
      } as never)
      .mockResolvedValueOnce({
        failed: false,
        stdout: `${networkA}\t${processA}\n`,
      } as never)
      .mockResolvedValueOnce({ failed: false, all: "" } as never)
      .mockResolvedValueOnce({ failed: false, all: "" } as never);

    const reconcile = createAgentTelemetryNetworkReconciler(
      "custom-otel-collector",
    );

    await reconcile();
    await reconcile();
    await reconcile();

    expect(vi.mocked(execa).mock.calls).toEqual([
      [
        "docker",
        ["inspect", "--format", "{{.Id}}", "custom-otel-collector"],
        { all: true, reject: false },
      ],
      [
        "docker",
        [
          "network",
          "ls",
          "--filter",
          "label=com.eveland.managed=agent-telemetry",
          "--format",
          '{{.Name}}\t{{.Label "com.eveland.process"}}',
        ],
        { all: true, reject: false },
      ],
      [
        "docker",
        ["inspect", "--type", "container", processA],
        { all: true, reject: false },
      ],
      [
        "docker",
        [
          "network",
          "connect",
          "--alias",
          "eveland-otel-collector",
          networkA,
          "custom-otel-collector",
        ],
        { all: true, reject: false },
      ],
      [
        "docker",
        ["inspect", "--type", "container", processB],
        { all: true, reject: false },
      ],
      [
        "docker",
        ["inspect", "--format", "{{.Id}}", "custom-otel-collector"],
        { all: true, reject: false },
      ],
      [
        "docker",
        ["inspect", "--format", "{{.Id}}", "custom-otel-collector"],
        { all: true, reject: false },
      ],
      [
        "docker",
        [
          "network",
          "ls",
          "--filter",
          "label=com.eveland.managed=agent-telemetry",
          "--format",
          '{{.Name}}\t{{.Label "com.eveland.process"}}',
        ],
        { all: true, reject: false },
      ],
      [
        "docker",
        ["inspect", "--type", "container", processA],
        { all: true, reject: false },
      ],
      [
        "docker",
        [
          "network",
          "connect",
          "--alias",
          "eveland-otel-collector",
          networkA,
          "custom-otel-collector",
        ],
        { all: true, reject: false },
      ],
    ]);
  });

  test("silently retries after the Collector container is absent", async () => {
    vi.mocked(execa).mockClear();
    vi.mocked(execa)
      .mockResolvedValueOnce({
        failed: true,
        all: "Error: No such object: eveland-otel-collector",
      } as never)
      .mockResolvedValueOnce({
        failed: false,
        stdout: "collector-id-restored\n",
      } as never)
      .mockResolvedValueOnce({ failed: false, stdout: "" } as never);
    const reconcile = createAgentTelemetryNetworkReconciler();

    await expect(reconcile()).resolves.toBeUndefined();
    await expect(reconcile()).resolves.toBeUndefined();

    expect(vi.mocked(execa).mock.calls).toHaveLength(3);
  });
});

describe("createDockerAdapter", () => {
  test("exposes the docker adapter name", () => {
    const adapter = createDockerAdapter(dockerAdapterConfig);
    expect(adapter.name).toBe("docker");
  });

  test("buildRelease writes a Dockerfile and shells out to docker build with the derived image tag", async () => {
    vi.mocked(execa).mockClear();
    vi.mocked(injectSandboxModules).mockClear();
    vi.mocked(execa)
      .mockResolvedValueOnce({ all: "" } as never)
      .mockResolvedValueOnce({ all: "docker build ok" } as never)
      .mockResolvedValueOnce({ exitCode: 0, all: "SANDBOX VERIFY OK" } as never);
    const buildDir = await mkdtemp(path.join(os.tmpdir(), "eveland-build-"));
    const adapter = createDockerAdapter(dockerAdapterConfig);

    const result = await adapter.buildRelease({
      projectId: "Proj_123",
      releaseId: "Rel_456",
      sourcePath: "/workspace/source",
      buildDir,
      commandContext: { isEveProject: true, hasLockfile: true, scripts: {} },
    });

    const dockerfilePath = path.join(buildDir, "Dockerfile");
    const contents = await readFile(dockerfilePath, "utf8");
    expect(contents).toContain("FROM node:24-alpine");
    await expect(readFile(path.join(buildDir, ".eveland", "verify-sandbox.mjs"), "utf8")).resolves.toContain(
      "node eveland-verify.ts",
    );

    expect(result.releaseRef).toBe("eveland/proj_123:rel_456");
    expect(injectSandboxModules).toHaveBeenCalledWith({
      releaseDir: buildDir,
      backendDistDir: "/opt/eveland/sandbox-bwrap",
    });
    expect(result.log).toContain("Injected eve sandbox modules: agent/sandbox.js");
    expect(result.log).toContain("Docker sandbox self-check passed");
    expect(vi.mocked(execa).mock.calls).toEqual([
      ["cp", ["-a", "/workspace/source/.", buildDir]],
      ["docker", ["build", "--file", dockerfilePath, "--tag", "eveland/proj_123:rel_456", buildDir], { all: true }],
      ["docker", buildDockerSandboxVerifyArgs("eveland/proj_123:rel_456"), { all: true, reject: false }],
    ]);
  });

  test("removes the Docker image and build directory when post-build verification fails", async () => {
    vi.mocked(execa).mockClear();
    vi.mocked(execa)
      .mockResolvedValueOnce({ all: "" } as never)
      .mockResolvedValueOnce({ all: "docker build ok" } as never)
      .mockResolvedValueOnce({
        exitCode: 1,
        all: "bwrap: Operation not permitted",
      } as never)
      .mockResolvedValueOnce({ failed: false, exitCode: 0, all: "" } as never);
    const buildDir = await mkdtemp(path.join(os.tmpdir(), "eveland-build-"));
    const adapter = createDockerAdapter(dockerAdapterConfig);

    await expect(
      adapter.buildRelease({
        projectId: "Proj_123",
        releaseId: "Rel_456",
        sourcePath: "/workspace/source",
        buildDir,
        commandContext: { isEveProject: true, hasLockfile: true, scripts: {} },
      }),
    ).rejects.toThrow(/Operation not permitted/);

    await expect(access(buildDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(vi.mocked(execa).mock.calls.at(-1)).toEqual([
      "docker",
      ["image", "rm", "eveland/proj_123:rel_456"],
      { all: true, reject: false },
    ]);
  });

  test("warns when an Eve release has no agent root to receive the sandbox module", async () => {
    vi.mocked(execa).mockClear();
    vi.mocked(injectSandboxModules).mockResolvedValueOnce({ generated: [], replaced: [] });
    vi.mocked(execa)
      .mockResolvedValueOnce({ all: "" } as never)
      .mockResolvedValueOnce({ all: "docker build ok" } as never)
      .mockResolvedValueOnce({ exitCode: 0, all: "SANDBOX VERIFY OK" } as never);
    const buildDir = await mkdtemp(path.join(os.tmpdir(), "eveland-build-"));
    const adapter = createDockerAdapter(dockerAdapterConfig);

    const result = await adapter.buildRelease({
      projectId: "Proj_123",
      releaseId: "Rel_456",
      sourcePath: "/workspace/source",
      buildDir,
      commandContext: { isEveProject: true, hasLockfile: true, scripts: {} },
    });

    expect(result.log).toMatch(/WARNING.*no agent\/ directory/i);
    expect(result.log).toContain("default sandbox backend chain");
  });

  test("reports replaced authored sandbox behavior while confirming workspace seeds are preserved", async () => {
    vi.mocked(execa).mockClear();
    vi.mocked(injectSandboxModules).mockResolvedValueOnce({
      generated: ["agent/sandbox/sandbox.js"],
      replaced: ["agent/sandbox/sandbox.ts"],
    });
    vi.mocked(execa)
      .mockResolvedValueOnce({ all: "" } as never)
      .mockResolvedValueOnce({ all: "docker build ok" } as never)
      .mockResolvedValueOnce({ exitCode: 0, all: "SANDBOX VERIFY OK" } as never);
    const buildDir = await mkdtemp(path.join(os.tmpdir(), "eveland-build-"));
    const adapter = createDockerAdapter(dockerAdapterConfig);

    const result = await adapter.buildRelease({
      projectId: "Proj_123",
      releaseId: "Rel_456",
      sourcePath: "/workspace/source",
      buildDir,
      commandContext: { isEveProject: true, hasLockfile: true, scripts: {} },
    });

    expect(result.log).toContain("bootstrap()");
    expect(result.log).toContain("onSession()");
    expect(result.log).toContain("workspace seeds are preserved");
  });

  test("startProcess publishes the configured internal port and runs the eve start command", async () => {
    vi.mocked(execa).mockClear();
    const adapter = createDockerAdapter(dockerAdapterConfig);
    const sandboxCacheDir = "/var/lib/eveland-data/sandbox/proj_123";

    const result = await adapter.startProcess({
      processName: "eveland-proj_123",
      releaseRef: "eveland/proj_123:rel_456",
      port: 43123,
      env: { OPENAI_API_KEY: "sk-test-123456" },
      commandContext: { isEveProject: true, hasLockfile: true, scripts: {} },
      sandboxCacheDir,
      observabilityPolicyDir:
        "/var/lib/eveland-data/observability/proj_123/dep_456",
    });

    expect(result.internalPort).toBe(3000);
    const networkName =
      resolveAgentTelemetryNetworkName("eveland-proj_123");
    expect(vi.mocked(execa).mock.calls[0]).toEqual([
      "docker",
      ["network", "inspect", networkName],
      { all: true, reject: false },
    ]);
    expect(vi.mocked(execa).mock.calls[1]).toEqual([
      "docker",
      [
        "network",
        "connect",
        "--alias",
        "eveland-otel-collector",
        networkName,
        "eveland-otel-collector",
      ],
      { all: true, reject: false },
    ]);
    expect(vi.mocked(execa).mock.calls).toHaveLength(3);
    const [command, args] = vi.mocked(execa).mock.calls[2]!;
    expect(command).toBe("docker");
    expect(args).toContain("--publish");
    expect(args).toContain("127.0.0.1:43123:3000");
    expect(args).toContain("eveland/proj_123:rel_456");
    expect(args as string[]).toContain(`${sandboxCacheDir}:/var/lib/eveland-sandbox`);
    expect(args as string[]).toContain("EVELAND_SANDBOX_CACHE_DIR=/var/lib/eveland-sandbox");
    const runCommand = (args as string[]).at(-1);
    expect(runCommand).toContain("exec npx eve start --host 0.0.0.0 --port 3000");
  });

  test("creates and connects a deployment-isolated Agent telemetry network when it is missing", async () => {
    vi.mocked(execa).mockClear();
    const processName = "eveland-proj_123-dep_456";
    const networkName =
      resolveAgentTelemetryNetworkName(processName);
    vi.mocked(execa)
      .mockResolvedValueOnce({
        failed: true,
        all: `Error: No such network: ${networkName}`,
      } as never)
      .mockResolvedValueOnce({ failed: false, all: "" } as never)
      .mockResolvedValueOnce({ failed: false, all: "" } as never);

    await expect(
      ensureAgentTelemetryNetwork(
        processName,
        "custom-otel-collector",
      ),
    ).resolves.toBeUndefined();

    expect(vi.mocked(execa).mock.calls).toEqual([
      [
        "docker",
        ["network", "inspect", networkName],
        { all: true, reject: false },
      ],
      [
        "docker",
        [
          "network",
          "create",
          "--label",
          "com.eveland.managed=agent-telemetry",
          "--label",
          `com.eveland.process=${processName}`,
          networkName,
        ],
        { all: true, reject: false },
      ],
      [
        "docker",
        [
          "network",
          "connect",
          "--alias",
          "eveland-otel-collector",
          networkName,
          "custom-otel-collector",
        ],
        { all: true, reject: false },
      ],
    ]);
  });

  test("starts without the Collector and leaves the network for reconciliation", async () => {
    vi.mocked(execa).mockClear();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(execa)
      .mockResolvedValueOnce({ failed: false, all: "" } as never)
      .mockResolvedValueOnce({
        failed: true,
        all: "Error response from daemon: No such container: eveland-otel-collector",
      } as never)
      .mockResolvedValueOnce({ failed: false, all: "agent started" } as never);
    const adapter = createDockerAdapter(dockerAdapterConfig);

    await expect(
      adapter.startProcess({
        processName: "eveland-proj_123-dep_456",
        releaseRef: "eveland/proj_123:rel_456",
        port: 43123,
        env: {},
        commandContext: {
          isEveProject: true,
          hasLockfile: true,
          scripts: {},
        },
        sandboxCacheDir:
          "/var/lib/eveland-data/sandbox/proj_123",
        observabilityPolicyDir:
          "/var/lib/eveland-data/observability/proj_123/dep_456",
      }),
    ).resolves.toMatchObject({ log: "agent started" });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Collector"),
    );
    warn.mockRestore();
  });

  test("finds and removes a managed network only while its Agent container is absent", async () => {
    vi.mocked(execa).mockClear();
    const processName = "eveland-proj_orphan-dep_orphan";
    const networkName =
      resolveAgentTelemetryNetworkName(processName);
    vi.mocked(execa)
      .mockResolvedValueOnce({
        failed: false,
        stdout: `${networkName}\t${processName}\n`,
      } as never)
      .mockResolvedValueOnce({
        failed: true,
        all: `Error: No such container: ${processName}`,
      } as never);

    await expect(
      listOrphanAgentTelemetryNetworks(),
    ).resolves.toEqual([{ name: networkName, processName }]);

    vi.mocked(execa)
      .mockResolvedValueOnce({
        failed: true,
        all: `Error: No such container: ${processName}`,
      } as never)
      .mockResolvedValueOnce({ failed: false, all: "" } as never)
      .mockResolvedValueOnce({ failed: false, all: "" } as never);

    await expect(
      removeOrphanAgentTelemetryNetwork({
        name: networkName,
        processName,
      }),
    ).resolves.toBe(true);
  });

  test("ensureProcess reuses a running container without starting another process", async () => {
    vi.mocked(execa).mockClear();
    vi.mocked(execa).mockResolvedValueOnce({ failed: false, stdout: "running\n", all: "running\n" } as never);
    const adapter = createDockerAdapter(dockerAdapterConfig);

    const result = await adapter.ensureProcess!({
      processName: "eveland-proj_123",
      releaseRef: "eveland/proj_123:rel_456",
      port: 43123,
      env: {},
      commandContext: { isEveProject: true, hasLockfile: true, scripts: {} },
      sandboxCacheDir: "/var/lib/eveland-data/sandbox/proj_123",
      observabilityPolicyDir:
        "/var/lib/eveland-data/observability/proj_123/dep_456",
    });

    expect(result.log).toContain("Reused ready Docker process");
    expect(vi.mocked(execa).mock.calls).toEqual([
      ["docker", ["inspect", "--format", "{{.State.Status}}", "eveland-proj_123"], { all: true, reject: false }],
    ]);
  });

  test("collects bounded container state and recent logs before cleanup", async () => {
    vi.mocked(execa).mockClear();
    vi.mocked(execa)
      .mockResolvedValueOnce({
        failed: false,
        stdout: "status=restarting restarting=true exitCode=1 oomKilled=false restartCount=4",
        all: "status=restarting restarting=true exitCode=1 oomKilled=false restartCount=4",
      } as never)
      .mockResolvedValueOnce({ failed: false, all: "Eve startup failed\nstack trace" } as never);
    const adapter = createDockerAdapter(dockerAdapterConfig) as ReturnType<typeof createDockerAdapter> & {
      getProcessDiagnostics(processName: string): Promise<{ state: string; logs: string }>;
    };

    await expect(adapter.getProcessDiagnostics("eveland-proj_123")).resolves.toEqual({
      state: "status=restarting restarting=true exitCode=1 oomKilled=false restartCount=4",
      logs: "Eve startup failed\nstack trace",
    });
    expect(vi.mocked(execa).mock.calls).toEqual([
      [
        "docker",
        [
          "inspect",
          "--format",
          "status={{.State.Status}} restarting={{.State.Restarting}} exitCode={{.State.ExitCode}} oomKilled={{.State.OOMKilled}} restartCount={{.RestartCount}} error={{json .State.Error}}",
          "eveland-proj_123",
        ],
        { all: true, reject: false },
      ],
      ["docker", ["logs", "--tail", "200", "eveland-proj_123"], { all: true, reject: false }],
    ]);
  });

  test("stopProcess shells out to docker rm --force with the process name", async () => {
    vi.mocked(execa).mockClear();
    const adapter = createDockerAdapter(dockerAdapterConfig);

    await adapter.stopProcess("eveland-proj_123");

    const networkName =
      resolveAgentTelemetryNetworkName("eveland-proj_123");
    expect(vi.mocked(execa).mock.calls).toEqual([
      ["docker", ["rm", "--force", "eveland-proj_123"], { reject: false }],
      [
        "docker",
        [
          "network",
          "disconnect",
          "--force",
          networkName,
          "eveland-otel-collector",
        ],
        { all: true, reject: false },
      ],
      [
        "docker",
        ["network", "rm", networkName],
        { all: true, reject: false },
      ],
    ]);
  });

  test("stopProcess tolerates 'No such container' as a benign not-found (idempotent re-run)", async () => {
    vi.mocked(execa).mockClear();
    vi.mocked(execa).mockResolvedValueOnce({
      failed: true,
      exitCode: 1,
      stderr: "Error: No such container: eveland-proj_123",
      all: "",
    } as never);
    const adapter = createDockerAdapter(dockerAdapterConfig);

    await expect(adapter.stopProcess("eveland-proj_123")).resolves.toBeUndefined();
  });

  test("stopProcess succeeds when telemetry network cleanup still has active endpoints", async () => {
    vi.mocked(execa).mockClear();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(execa)
      .mockResolvedValueOnce({ failed: false } as never)
      .mockResolvedValueOnce({ failed: false, all: "" } as never)
      .mockResolvedValueOnce({
        failed: true,
        all: "Error response from daemon: network has active endpoints",
      } as never);
    const adapter = createDockerAdapter(dockerAdapterConfig);

    await expect(
      adapter.stopProcess("eveland-proj_123"),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("orphan sweep will retry"),
    );
    warn.mockRestore();
  });

  test("stopProcess throws naming the command and stderr when the docker daemon is unreachable", async () => {
    vi.mocked(execa).mockClear();
    const stderr = "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?";
    vi.mocked(execa).mockResolvedValueOnce({ failed: true, exitCode: 1, stderr, all: "" } as never);
    const adapter = createDockerAdapter(dockerAdapterConfig);

    await expect(adapter.stopProcess("eveland-proj_123")).rejects.toThrow(/docker rm --force eveland-proj_123 failed/);
    vi.mocked(execa).mockResolvedValueOnce({ failed: true, exitCode: 1, stderr, all: "" } as never);
    await expect(adapter.stopProcess("eveland-proj_123")).rejects.toThrow(stderr);
  });

  test("stopProcess throws when the docker CLI itself cannot be spawned (ENOENT)", async () => {
    vi.mocked(execa).mockClear();
    vi.mocked(execa).mockResolvedValueOnce({ failed: true, exitCode: undefined, stderr: "", all: "" } as never);
    const adapter = createDockerAdapter(dockerAdapterConfig);

    await expect(adapter.stopProcess("eveland-proj_123")).rejects.toThrow(/docker rm --force eveland-proj_123 failed/);
  });

  test("stopProcess throws on an unknown non-zero exit", async () => {
    vi.mocked(execa).mockClear();
    vi.mocked(execa).mockResolvedValueOnce({ failed: true, exitCode: 1, stderr: "permission denied", all: "" } as never);
    const adapter = createDockerAdapter(dockerAdapterConfig);

    await expect(adapter.stopProcess("eveland-proj_123")).rejects.toThrow(/permission denied/);
  });

  test("removeRelease tolerates an image that was already removed by a deletion retry", async () => {
    vi.mocked(execa).mockClear();
    vi.mocked(execa).mockResolvedValueOnce({
      failed: true,
      exitCode: 1,
      stderr: "Error response from daemon: No such image: eveland/proj_123:rel_456",
      all: "",
    } as never);
    const adapter = createDockerAdapter(dockerAdapterConfig);

    await expect(adapter.removeRelease!("eveland/proj_123:rel_456")).resolves.toBeUndefined();
    expect(vi.mocked(execa).mock.calls).toEqual([
      ["docker", ["image", "rm", "eveland/proj_123:rel_456"], { all: true, reject: false }],
    ]);
  });

  test("removeRelease still fails when Docker is unavailable", async () => {
    vi.mocked(execa).mockClear();
    const stderr = "Cannot connect to the Docker daemon";
    vi.mocked(execa).mockResolvedValueOnce({ failed: true, exitCode: 1, stderr, all: "" } as never);
    const adapter = createDockerAdapter(dockerAdapterConfig);

    await expect(adapter.removeRelease!("eveland/proj_123:rel_456")).rejects.toThrow(stderr);
  });
});

describe("isBenignDockerStopFailure", () => {
  test("tolerates a successful call", () => {
    expect(isBenignDockerStopFailure({ failed: false })).toBe(true);
  });

  test("tolerates 'No such container' -- the idempotent not-found case", () => {
    expect(isBenignDockerStopFailure({ failed: true, exitCode: 1, stderr: "Error: No such container: eveland-proj_123" })).toBe(true);
  });

  test("does not tolerate a spawn failure (docker CLI missing, no exit code or stderr)", () => {
    expect(isBenignDockerStopFailure({ failed: true, exitCode: undefined, stderr: "" })).toBe(false);
  });

  test("does not tolerate a daemon-unreachable error", () => {
    expect(
      isBenignDockerStopFailure({
        failed: true,
        exitCode: 1,
        stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
      }),
    ).toBe(false);
  });

  test("does not tolerate an unknown non-zero exit", () => {
    expect(isBenignDockerStopFailure({ failed: true, exitCode: 1, stderr: "permission denied" })).toBe(false);
  });
});
