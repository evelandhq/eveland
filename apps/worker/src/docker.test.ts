import { describe, expect, test, vi } from "vitest";
import { execa } from "execa";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildDockerBuildArgs, buildDockerRunArgs, buildDockerStartCommand, createDockerAdapter, writeGeneratedDockerfile } from "./runtime/docker.js";
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

    const result = await adapter.startProcess({
      processName: "eveland-proj_123",
      releaseRef: "eveland/proj_123:rel_456",
      port: 43123,
      env: { OPENAI_API_KEY: "sk-test-123456" },
      commandContext: { isEveProject: true, hasLockfile: true, scripts: {} },
    });

    expect(result.internalPort).toBe(3000);
    expect(vi.mocked(execa).mock.calls).toHaveLength(1);
    const [command, args] = vi.mocked(execa).mock.calls[0]!;
    expect(command).toBe("docker");
    expect(args).toContain("--publish");
    expect(args).toContain("127.0.0.1:43123:3000");
    expect(args).toContain("eveland/proj_123:rel_456");
    const runCommand = (args as string[]).at(-1);
    expect(runCommand).toContain("exec npx eve start --host 0.0.0.0 --port 3000");
  });

  test("stopProcess shells out to docker rm --force with the process name", async () => {
    vi.mocked(execa).mockClear();
    const adapter = createDockerAdapter({ internalPort: 3000 });

    await adapter.stopProcess("eveland-proj_123");

    expect(vi.mocked(execa).mock.calls).toEqual([["docker", ["rm", "--force", "eveland-proj_123"], { reject: false }]]);
  });
});
