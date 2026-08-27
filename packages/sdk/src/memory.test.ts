import { open, mkdtemp, readdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";
import { fileMemory, MemoryDocumentConflictError as EveConflictError } from "eve/memory/file";
import type { MemoryDocumentBackend as EveMemoryDocumentBackend } from "eve/memory/file";

import { evelandMemoryBackend, MemoryDocumentConflictError } from "./memory.js";

const signal = new AbortController().signal;

async function backendInTempRoot() {
  const root = await mkdtemp(join(tmpdir(), "eveland-memory-"));
  const backend = evelandMemoryBackend({ root });
  if (!backend) throw new Error("expected a backend for an explicit root");
  return { backend, root };
}

describe("evelandMemoryBackend", () => {
  test("returns undefined when no root is configured", () => {
    const previous = process.env.EVELAND_MEMORY_ROOT;
    delete process.env.EVELAND_MEMORY_ROOT;
    try {
      expect(evelandMemoryBackend()).toBeUndefined();
    } finally {
      if (previous !== undefined) process.env.EVELAND_MEMORY_ROOT = previous;
    }
  });

  test("reads the storage root from EVELAND_MEMORY_ROOT", async () => {
    const previous = process.env.EVELAND_MEMORY_ROOT;
    const root = await mkdtemp(join(tmpdir(), "eveland-memory-env-"));
    process.env.EVELAND_MEMORY_ROOT = root;
    try {
      const backend = evelandMemoryBackend();
      expect(backend).toBeDefined();
      await backend!.write({ key: "k", content: "hello", expectedVersion: null, signal });
      await expect(backend!.read({ key: "k", signal })).resolves.toMatchObject({
        content: "hello",
      });
    } finally {
      if (previous === undefined) delete process.env.EVELAND_MEMORY_ROOT;
      else process.env.EVELAND_MEMORY_ROOT = previous;
    }
  });

  test("reads null for a key that was never written", async () => {
    const { backend } = await backendInTempRoot();
    await expect(backend.read({ key: "missing", signal })).resolves.toBeNull();
  });

  test("creates a document with expectedVersion null and reads it back", async () => {
    const { backend } = await backendInTempRoot();
    const written = await backend.write({
      key: "k",
      content: "v1 content",
      expectedVersion: null,
      signal,
    });
    expect(written.content).toBe("v1 content");
    expect(written.version).toBeTypeOf("string");
    expect(written.version.length).toBeGreaterThan(0);
    await expect(backend.read({ key: "k", signal })).resolves.toEqual(written);
  });

  test("replaces a document when expectedVersion matches and bumps the version", async () => {
    const { backend } = await backendInTempRoot();
    const first = await backend.write({ key: "k", content: "one", expectedVersion: null, signal });
    const second = await backend.write({
      key: "k",
      content: "two",
      expectedVersion: first.version,
      signal,
    });
    expect(second.content).toBe("two");
    expect(second.version).not.toBe(first.version);
    await expect(backend.read({ key: "k", signal })).resolves.toEqual(second);
  });

  test("rejects a stale expectedVersion with a conflict Eve recognizes", async () => {
    const { backend } = await backendInTempRoot();
    const first = await backend.write({ key: "k", content: "one", expectedVersion: null, signal });
    await backend.write({ key: "k", content: "two", expectedVersion: first.version, signal });

    const stale = backend.write({
      key: "k",
      content: "three",
      expectedVersion: first.version,
      signal,
    });
    const error = await stale.then(
      () => {
        throw new Error("expected a conflict");
      },
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(MemoryDocumentConflictError);
    expect((error as MemoryDocumentConflictError).key).toBe("k");
    // Eve narrows conflicts structurally across bundle boundaries; the retry
    // loop inside fileMemory() only works if this holds.
    expect(EveConflictError.is(error)).toBe(true);
    // The losing write must not have replaced the document.
    await expect(backend.read({ key: "k", signal })).resolves.toMatchObject({ content: "two" });
  });

  test("rejects a create-only write when the document already exists", async () => {
    const { backend } = await backendInTempRoot();
    await backend.write({ key: "k", content: "one", expectedVersion: null, signal });
    await expect(
      backend.write({ key: "k", content: "again", expectedVersion: null, signal }),
    ).rejects.toSatisfy((error: unknown) => EveConflictError.is(error));
  });

  test("isolates keys, including ones that look like paths", async () => {
    const { backend, root } = await backendInTempRoot();
    await backend.write({ key: "a", content: "doc a", expectedVersion: null, signal });
    await backend.write({ key: "../escape", content: "doc b", expectedVersion: null, signal });
    await backend.write({ key: "app/agent:用户", content: "doc c", expectedVersion: null, signal });

    await expect(backend.read({ key: "a", signal })).resolves.toMatchObject({ content: "doc a" });
    await expect(backend.read({ key: "../escape", signal })).resolves.toMatchObject({
      content: "doc b",
    });
    await expect(backend.read({ key: "app/agent:用户", signal })).resolves.toMatchObject({
      content: "doc c",
    });
    // Nothing may land outside the root, whatever the key contains.
    const parentEntries = await readdir(join(root, ".."));
    expect(parentEntries.filter((name) => name.includes("escape"))).toEqual([]);
  });

  test("lets exactly one of many same-version writers win", async () => {
    const { backend } = await backendInTempRoot();
    const base = await backend.write({ key: "k", content: "base", expectedVersion: null, signal });

    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        backend.write({
          key: "k",
          content: `writer ${index}`,
          expectedVersion: base.version,
          signal,
        }),
      ),
    );
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(7);
    for (const outcome of rejected) {
      expect(EveConflictError.is(outcome.reason)).toBe(true);
    }
    const final = await backend.read({ key: "k", signal });
    expect(final?.content).toBe(
      (fulfilled[0] as PromiseFulfilledResult<{ content: string }>).value.content,
    );
  });

  test("rejects operations whose signal is already aborted", async () => {
    const { backend } = await backendInTempRoot();
    const controller = new AbortController();
    controller.abort();
    await expect(backend.read({ key: "k", signal: controller.signal })).rejects.toThrow();
    await expect(
      backend.write({ key: "k", content: "x", expectedVersion: null, signal: controller.signal }),
    ).rejects.toThrow();
  });

  test("takes over a lock abandoned by a crashed writer", async () => {
    const { backend, root } = await backendInTempRoot();
    await backend.write({ key: "k", content: "one", expectedVersion: null, signal });
    const [lockName] = (await readdir(root)).filter((name) => name.endsWith(".lock"));
    expect(lockName).toBeUndefined();

    // Simulate a crash: a lock file nobody will release, older than the stale
    // threshold.
    const [docName] = await readdir(root);
    const lockPath = join(root, `${docName!.replace(/\.json$/, "")}.lock`);
    const handle = await open(lockPath, "wx");
    await handle.close();
    const past = new Date(Date.now() - 60_000);
    await utimes(lockPath, past, past);

    const doc = await backend.read({ key: "k", signal });
    await expect(
      backend.write({ key: "k", content: "two", expectedVersion: doc!.version, signal }),
    ).resolves.toMatchObject({ content: "two" });
  });
});

describe("eve fileMemory integration", () => {
  test("the backend satisfies Eve's MemoryDocumentBackend type", async () => {
    const { backend } = await backendInTempRoot();
    const eveBackend: EveMemoryDocumentBackend = backend;
    expect(eveBackend).toBe(backend);
  });

  test("fileMemory saves and recalls through the backend", async () => {
    const { backend } = await backendInTempRoot();
    const provider = fileMemory({ backend });

    const memoryBinding = {
      scope: { key: "scope-key", namespace: "ns", value: "principal" },
      slot: "user_memory",
    };
    const tools = await provider.tools?.({
      memory: memoryBinding,
      turn: { id: "turn", input: [], sequence: 0 },
    } as never);
    expect(tools).toBeTruthy();
    await tools!.save_memory!.execute(
      { text: "prefers pnpm over npm" } as never,
      {
        abortSignal: signal,
      } as never,
    );

    const recalled = await provider.recall["turn.started"]({
      abortSignal: signal,
      memory: memoryBinding,
    } as never);
    expect(recalled?.messages[0]?.content).toContain("prefers pnpm over npm");

    // The document Eve wrote is a real versioned document in our store.
    const raw = await backend.read({ key: "scope-key", signal });
    expect(raw?.content).toContain("prefers pnpm over npm");
  });
});
