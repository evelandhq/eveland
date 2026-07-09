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
