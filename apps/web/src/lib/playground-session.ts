import type { FileUIPart, UserContent } from "ai";
import type { PendingPlaygroundMessage, PendingPlaygroundTurn } from "./playground-route-auth.js";

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
