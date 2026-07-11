import { describe, expect, test, vi } from "vitest";
import { execa } from "execa";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildDockerBuildArgs,
  buildDockerRunArgs,
  buildDockerStartCommand,
  createDockerAdapter,
  isBenignDockerStopFailure,
  writeGeneratedDockerfile,
} from "./runtime/docker.js";
import { processSafeName } from "./runtime/types.js";

// Module-scoped: every test in this file runs against the mocked execa. This is safe
// because every other suite here exercises pure functions (buildDockerBuildArgs,
// buildDockerRunArgs, writeGeneratedDockerfile — which only writes a file, no execa).
vi.mock("execa", () => ({
  execa: vi.fn(async () => ({ all: "" })),
}));

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

describe("buildDockerRunArgs", () => {
  test("creates a local-only docker run command with env injection and runtime command", () => {
    const args = buildDockerRunArgs({
      containerName: "eveland-proj_123",
      imageTag: "eveland/proj_123:rel_456",
      internalPort: 3000,
      hostPort: 43123,
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
      "--add-host",
      "host.docker.internal:host-gateway",
      "--publish",
      "127.0.0.1:43123:3000",
      "--env",
      "OPENAI_API_KEY=sk-test-123456",
      "eveland/proj_123:rel_456",
      "sh",
      "-lc",
      "npm run start",
    ]);
  });

  test("buildDockerRunArgs adds one --add-host per extraHosts entry", () => {
    const args = buildDockerRunArgs({
      containerName: "eveland-demo",
      imageTag: "img:1",
      internalPort: 3000,
      hostPort: 41000,
      env: {},
      command: "npx eve start",
      extraHosts: ["demo.lvh.me:host-gateway"],
    });
    const index = args.indexOf("demo.lvh.me:host-gateway");
    expect(index).toBeGreaterThan(0);
    expect(args[index - 1]).toBe("--add-host");
  });
});

describe("writeGeneratedDockerfile", () => {
  test("creates a Node runtime image definition without modifying source files", async () => {
    const buildDir = await mkdtemp(path.join(os.tmpdir(), "eveland-build-"));
    const dockerfilePath = await writeGeneratedDockerfile(buildDir);
    const contents = await readFile(dockerfilePath, "utf8");

    expect(dockerfilePath).toBe(path.join(buildDir, "Dockerfile"));
    expect(contents).toContain("FROM node:24-alpine");
    expect(contents).toContain("COPY package*.json ./");
    expect(contents).toContain("COPY . .");
    expect(contents).toContain("npx eve build");
    expect(contents).toContain("EXPOSE 3000");
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

describe("createDockerAdapter", () => {
  test("exposes the docker adapter name", () => {
    const adapter = createDockerAdapter({ internalPort: 3000 });
    expect(adapter.name).toBe("docker");
  });

  test("buildRelease writes a Dockerfile and shells out to docker build with the derived image tag", async () => {
    vi.mocked(execa).mockClear();
    const buildDir = await mkdtemp(path.join(os.tmpdir(), "eveland-build-"));
    const adapter = createDockerAdapter({ internalPort: 3000 });

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

    expect(result.releaseRef).toBe("eveland/proj_123:rel_456");
    expect(vi.mocked(execa).mock.calls).toEqual([["docker", ["build", "--file", dockerfilePath, "--tag", "eveland/proj_123:rel_456", "/workspace/source"], { all: true }]]);
  });

  test("startProcess publishes the configured internal port and runs the eve start command", async () => {
    vi.mocked(execa).mockClear();
    const adapter = createDockerAdapter({ internalPort: 3000 });
    const sandboxCacheDir = "/var/lib/eveland-data/sandbox/proj_123";

    const result = await adapter.startProcess({
      processName: "eveland-proj_123",
      releaseRef: "eveland/proj_123:rel_456",
      port: 43123,
      env: { OPENAI_API_KEY: "sk-test-123456" },
      commandContext: { isEveProject: true, hasLockfile: true, scripts: {} },
      // Set by every caller (see ProcessStartInput), but the docker adapter must
      // ignore it: containers get a fresh filesystem per run, no host directory
      // to grant.
      sandboxCacheDir,
    });

    expect(result.internalPort).toBe(3000);
    expect(vi.mocked(execa).mock.calls).toHaveLength(1);
    const [command, args] = vi.mocked(execa).mock.calls[0]!;
    expect(command).toBe("docker");
    expect(args).toContain("--publish");
    expect(args).toContain("127.0.0.1:43123:3000");
    expect(args).toContain("eveland/proj_123:rel_456");
    // The docker adapter must not leak the sandbox cache dir or its env var
    // name into the container's argv -- a blunt `.not.toContain("sandbox")`
    // substring check would also pass if the dir were renamed to something
    // that happens not to contain that word, so assert on the actual values.
    expect(args as string[]).not.toContain(sandboxCacheDir);
    expect(JSON.stringify(args)).not.toContain(sandboxCacheDir);
    expect(JSON.stringify(args)).not.toContain("EVELAND_SANDBOX_CACHE_DIR");
    const runCommand = (args as string[]).at(-1);
    expect(runCommand).toContain("exec npx eve start --host 0.0.0.0 --port 3000");
  });

  test("stopProcess shells out to docker rm --force with the process name", async () => {
    vi.mocked(execa).mockClear();
    const adapter = createDockerAdapter({ internalPort: 3000 });

    await adapter.stopProcess("eveland-proj_123");

    expect(vi.mocked(execa).mock.calls).toEqual([["docker", ["rm", "--force", "eveland-proj_123"], { reject: false }]]);
  });

  test("stopProcess tolerates 'No such container' as a benign not-found (idempotent re-run)", async () => {
    vi.mocked(execa).mockClear();
    vi.mocked(execa).mockResolvedValueOnce({
      failed: true,
      exitCode: 1,
      stderr: "Error: No such container: eveland-proj_123",
      all: "",
    } as never);
    const adapter = createDockerAdapter({ internalPort: 3000 });

    await expect(adapter.stopProcess("eveland-proj_123")).resolves.toBeUndefined();
  });

  test("stopProcess throws naming the command and stderr when the docker daemon is unreachable", async () => {
    vi.mocked(execa).mockClear();
    const stderr = "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?";
    vi.mocked(execa).mockResolvedValueOnce({ failed: true, exitCode: 1, stderr, all: "" } as never);
    const adapter = createDockerAdapter({ internalPort: 3000 });

    await expect(adapter.stopProcess("eveland-proj_123")).rejects.toThrow(/docker rm --force eveland-proj_123 failed/);
    vi.mocked(execa).mockResolvedValueOnce({ failed: true, exitCode: 1, stderr, all: "" } as never);
    await expect(adapter.stopProcess("eveland-proj_123")).rejects.toThrow(stderr);
  });

  test("stopProcess throws when the docker CLI itself cannot be spawned (ENOENT)", async () => {
    vi.mocked(execa).mockClear();
    vi.mocked(execa).mockResolvedValueOnce({ failed: true, exitCode: undefined, stderr: "", all: "" } as never);
    const adapter = createDockerAdapter({ internalPort: 3000 });

    await expect(adapter.stopProcess("eveland-proj_123")).rejects.toThrow(/docker rm --force eveland-proj_123 failed/);
  });

  test("stopProcess throws on an unknown non-zero exit", async () => {
    vi.mocked(execa).mockClear();
    vi.mocked(execa).mockResolvedValueOnce({ failed: true, exitCode: 1, stderr: "permission denied", all: "" } as never);
    const adapter = createDockerAdapter({ internalPort: 3000 });

    await expect(adapter.stopProcess("eveland-proj_123")).rejects.toThrow(/permission denied/);
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
