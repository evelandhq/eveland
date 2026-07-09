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
    await handle.shutdown();

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

  test("shutdown kills the session's live processes and leaves the workspace on disk", async () => {
    const { backend, runtimeContext } = await makeBackend();
    const handle = await backend.create({ templateKey: null, sessionKey: "sess-shutdown", runtimeContext });
    await handle.session.writeTextFile({ path: "keep.txt", content: "durable" });

    await handle.shutdown();

    const again = await backend.create({ templateKey: null, sessionKey: "sess-shutdown", runtimeContext });
    expect(await again.session.readTextFile({ path: "keep.txt" })).toBe("durable");
  });

  test("the handle exposes shutdown and no longer exposes dispose", async () => {
    const { backend, runtimeContext } = await makeBackend();
    const handle = await backend.create({ templateKey: null, sessionKey: "sess-api", runtimeContext });
    expect(typeof handle.shutdown).toBe("function");
    expect((handle as unknown as Record<string, unknown>).dispose).toBeUndefined();
  });
});

describe("public API", () => {
  test("exposes the frozen backend name and factory", () => {
    expect(BWRAP_BACKEND_NAME).toBe("bwrap");
    expect(bwrap().name).toBe("bwrap");
    expect(typeof isBwrapAvailable).toBe("function");
  });
});
