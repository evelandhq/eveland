import type { FileUIPart, UserContent } from "ai";

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

export async function resetPlaygroundConversation(input: {
  session: { reset(): Promise<unknown> };
  clear: () => void;
}): Promise<void> {
  await input.session.reset();
  input.clear();
}
