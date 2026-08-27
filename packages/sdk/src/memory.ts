import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * These types are structurally identical to the ones Eve exports from
 * `eve/memory/file`, restated here on purpose: a storage backend is two
 * functions over plain data, and Eve narrows its conflict error by shape
 * (`name` + `key`), not by instance. Restating the seam keeps this module free
 * of any runtime or type dependency on `eve`, so it never has to move when the
 * hosted Eve window slides. The test suite pins the equivalence against the
 * newest Eve in the window.
 */
export type MemoryDocument = {
  /** Complete UTF-8 document contents. */
  readonly content: string;
  /** Opaque version used for optimistic writes. */
  readonly version: string;
};

export type MemoryDocumentReadInput = {
  /** Stable Eve scope key for the authored memory slot. */
  readonly key: string;
  readonly signal: AbortSignal;
};

export type MemoryDocumentWriteInput = MemoryDocumentReadInput & {
  readonly content: string;
  /** Version returned by a prior read, or `null` for create-only. */
  readonly expectedVersion: string | null;
};

export type MemoryDocumentBackend = {
  readonly read: (input: MemoryDocumentReadInput) => Promise<MemoryDocument | null>;
  readonly write: (input: MemoryDocumentWriteInput) => Promise<MemoryDocument>;
};

/**
 * Raised when a document changed between read and conditional write. The
 * `name` and `key` shape is Eve's cross-bundle contract: `fileMemory()`
 * recognizes it structurally and retries the read-modify-write cycle, so this
 * class must keep that shape even though it does not extend Eve's own class.
 */
export class MemoryDocumentConflictError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`Memory document "${key}" changed before it could be updated.`);
    this.name = "MemoryDocumentConflictError";
    this.key = key;
  }
}

export type EvelandMemoryBackendOptions = {
  /**
   * Directory holding one file per memory scope key. Defaults to
   * `EVELAND_MEMORY_ROOT`. Isolation between projects is the platform's job:
   * Eve scope keys carry no project identity, so whoever sets this variable
   * must point every project at its own directory.
   */
  readonly root?: string;
};

/**
 * A `fileMemory()` storage backend over a plain directory.
 *
 * Returns `undefined` when no root is configured, so
 * `fileMemory({ backend: evelandMemoryBackend() })` stays portable: on
 * Eveland the injected `EVELAND_MEMORY_ROOT` selects this backend, and
 * everywhere else (`eve dev`, Vercel) the `undefined` falls through to Eve's
 * own environment defaults instead of failing.
 *
 * Documents are versioned with a per-document counter and written with
 * compare-and-swap semantics: a lock file serializes writers (with stale-lock
 * takeover for crashed holders) and the document itself is replaced by atomic
 * rename, so readers never observe a partial write. This is a single-host
 * design on purpose -- it matches how Eveland runs deployments, and the seam
 * is small enough to swap for a database- or API-backed implementation
 * without touching agent code.
 */
export function evelandMemoryBackend(
  options: EvelandMemoryBackendOptions = {},
): MemoryDocumentBackend | undefined {
  const root = options.root ?? process.env.EVELAND_MEMORY_ROOT?.trim();
  if (!root) return undefined;

  return {
    read: async (input) => {
      input.signal.throwIfAborted();
      return readDocument(root, input.key, input.signal);
    },
    write: async (input) => {
      input.signal.throwIfAborted();
      await mkdir(root, { recursive: true });
      const lockPath = keyPath(root, input.key, ".lock");
      await acquireLock(lockPath, input.signal);
      try {
        const current = await readDocument(root, input.key, input.signal);
        if (
          current === null
            ? input.expectedVersion !== null
            : current.version !== input.expectedVersion
        ) {
          throw new MemoryDocumentConflictError(input.key);
        }
        const next: MemoryDocument = {
          content: input.content,
          version: current === null ? "1" : bumpVersion(current.version, input.key),
        };
        await replaceDocument(root, input.key, next, input.signal);
        return next;
      } finally {
        await rm(lockPath, { force: true });
      }
    },
  };
}

/** How long a writer may hold the lock before a peer treats it as abandoned. */
const LOCK_STALE_MS = 10_000;
/** Pause between lock attempts; a healthy holder needs only a few of these. */
const LOCK_RETRY_MS = 15;

/**
 * One flat file per key. The key is an arbitrary string Eve derives from the
 * memory scope, so it is hashed rather than sanitized: hashing keeps every
 * possible key -- separators, traversal sequences, unicode -- inside the root
 * with zero collision handling beyond SHA-256 itself. The original key is
 * stored inside the document for operators reading the directory.
 */
function keyPath(root: string, key: string, suffix: ".json" | ".lock"): string {
  return join(root, `${createHash("sha256").update(key, "utf8").digest("hex")}${suffix}`);
}

async function readDocument(
  root: string,
  key: string,
  signal: AbortSignal,
): Promise<MemoryDocument | null> {
  let raw: string;
  try {
    raw = await readFile(keyPath(root, key, ".json"), { encoding: "utf8", signal });
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidStoredDocument(key);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { key?: unknown }).key !== key ||
    typeof (parsed as { content?: unknown }).content !== "string" ||
    typeof (parsed as { version?: unknown }).version !== "string" ||
    (parsed as { version: string }).version.length === 0
  ) {
    throw invalidStoredDocument(key);
  }
  const document = parsed as { content: string; version: string };
  return { content: document.content, version: document.version };
}

/**
 * Replaces the document via write-then-rename so a concurrent reader sees
 * either the previous complete document or the next one, never a torn file.
 */
async function replaceDocument(
  root: string,
  key: string,
  document: MemoryDocument,
  signal: AbortSignal,
): Promise<void> {
  const target = keyPath(root, key, ".json");
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      JSON.stringify({ key, version: document.version, content: document.content }),
      { encoding: "utf8", signal },
    );
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Serializes writers on one document. `wx` creation is the atomic claim; a
 * lock older than LOCK_STALE_MS belongs to a crashed writer (a healthy hold
 * spans one read and one rename) and is taken over by renaming it away first,
 * so two waiters discovering the same stale lock cannot each delete a lock
 * the other just created.
 */
async function acquireLock(lockPath: string, signal: AbortSignal): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    try {
      const handle = await open(lockPath, "wx");
      await handle.close();
      return;
    } catch (error) {
      if (!isErrnoCode(error, "EEXIST")) throw error;
    }
    let heldSinceMs: number;
    try {
      heldSinceMs = (await stat(lockPath)).mtimeMs;
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) continue; // released between attempts
      throw error;
    }
    if (Date.now() - heldSinceMs > LOCK_STALE_MS) {
      try {
        const abandoned = `${lockPath}.${randomUUID()}.abandoned`;
        await rename(lockPath, abandoned);
        await rm(abandoned, { force: true });
      } catch (error) {
        if (!isErrnoCode(error, "ENOENT")) throw error;
      }
      continue;
    }
    await delay(LOCK_RETRY_MS, signal);
  }
}

function bumpVersion(version: string, key: string): string {
  if (!/^[1-9][0-9]*$/.test(version)) throw invalidStoredDocument(key);
  return String(Number(version) + 1);
}

function invalidStoredDocument(key: string): TypeError {
  return new TypeError(
    `Memory document "${key}" in EVELAND_MEMORY_ROOT is not a document this backend wrote.`,
  );
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code
  );
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        signal.reason instanceof Error ? signal.reason : new Error("The operation was aborted."),
      );
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
