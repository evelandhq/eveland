import type { FileUIPart, UserContent } from "ai";
import type {
  PendingPlaygroundMessage,
  PendingPlaygroundTurn,
  StorageLike,
} from "./playground-route-auth.js";

// Playground turn shaping and session sequencing. These are session
// behaviors, not HTTP calls: keeping them out of client-api leaves that
// module a pure transport surface (groupPlaygroundParts and the route-auth
// protocol are this module's neighbors).

export function createPlaygroundMessage(
  text: string,
  files: readonly FileUIPart[],
): string | UserContent {
  const trimmed = text.trim();
  if (files.length === 0) {
    return trimmed;
  }

  return [
    ...(trimmed.length > 0 ? [{ type: "text" as const, text: trimmed }] : []),
    ...files.map((file) => ({
      type: "file" as const,
      data: file.url,
      filename: file.filename,
      mediaType: file.mediaType,
    })),
  ];
}

/**
 * Completes a turn interrupted by a route-auth redirect: replays the durable
 * session that preceded the redirect (when one existed), then re-sends the
 * message the 401 rejected. A failed replay must not swallow the user's
 * message, so resume errors are absorbed here — they still surface through
 * the agent hook's own error channel — and the send proceeds regardless.
 */
export async function resumePendingPlaygroundTurn(input: {
  pending: PendingPlaygroundTurn;
  resume: () => Promise<void>;
  send: (message: PendingPlaygroundMessage) => Promise<void>;
}): Promise<void> {
  if (input.pending.session) {
    await input.resume().catch(() => undefined);
  }
  await input.send(input.pending.message);
}

/**
 * A first turn whose session-create outcome is unresolved: the request
 * failed (or the page was left) after the server may already have committed
 * the workflow. The message and its stable `operationId` persist together so
 * an explicit retry re-sends the identical create — which the server dedupes
 * into the committed Session instead of executing the input twice (#407).
 * Nothing is ever re-sent automatically from this stash.
 */
export type PendingSessionCreate = {
  message: PendingPlaygroundMessage;
  operationId: string;
};

export function stashPendingSessionCreate(
  storage: StorageLike,
  projectId: string,
  pending: PendingSessionCreate,
): void {
  storage.setItem(
    pendingCreateKey(projectId),
    JSON.stringify({ version: 1, message: pending.message, operationId: pending.operationId }),
  );
}

export function peekPendingSessionCreate(
  storage: StorageLike,
  projectId: string,
): PendingSessionCreate | null {
  const serialized = storage.getItem(pendingCreateKey(projectId));
  if (!serialized) return null;
  try {
    const value = JSON.parse(serialized) as {
      version?: unknown;
      message?: unknown;
      operationId?: unknown;
    };
    if (
      value.version !== 1 ||
      (typeof value.message !== "string" && !Array.isArray(value.message)) ||
      typeof value.operationId !== "string" ||
      value.operationId.length === 0
    ) {
      return null;
    }
    return {
      message: value.message as PendingPlaygroundMessage,
      operationId: value.operationId,
    };
  } catch {
    return null;
  }
}

export function clearPendingSessionCreate(storage: StorageLike, projectId: string): void {
  storage.removeItem(pendingCreateKey(projectId));
}

/**
 * True when a failed session create definitely never started a workflow —
 * the server rejected it up front (validation, authentication, limits) — so
 * the pending create can be discarded and composed afresh. Anything else
 * (opaque 500s, transport errors, local aborts) leaves the outcome unknown.
 * 408/425/429 are transport/readiness shapes, not verdicts on the create.
 */
export function isDefiniteCreateRejection(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("status" in error)) return false;
  const status = (error as { status: unknown }).status;
  if (typeof status !== "number") return false;
  return status >= 400 && status < 500 && ![408, 425, 429].includes(status);
}

function pendingCreateKey(projectId: string): string {
  return `eveland:playground:pending-create:${projectId}`;
}

export type PlaygroundTurnCancellation = {
  session: { cancel(): Promise<unknown> } | null;
  abort: () => void;
};

export async function cancelPlaygroundTurn(input: PlaygroundTurnCancellation): Promise<void> {
  if (!input.session) {
    input.abort();
    return;
  }
  await input.session.cancel();
}

export function createPlaygroundTurnCanceller(): (
  input: PlaygroundTurnCancellation,
) => Promise<void> {
  let inFlight: Promise<void> | undefined;
  return (input) => {
    if (inFlight) return inFlight;
    inFlight = cancelPlaygroundTurn(input).finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
