import type { FileUIPart, UserContent } from "ai";

// Playground turn shaping and session sequencing. These are session
// behaviors, not HTTP calls: keeping them out of client-api leaves that
// module a pure transport surface (groupPlaygroundParts and the route-auth
// protocol are this module's neighbors).

export function createPlaygroundMessage(text: string, files: readonly FileUIPart[]): string | UserContent {
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

export async function cancelPlaygroundTurn(session: { cancel(): Promise<unknown> }): Promise<void> {
  await session.cancel();
}

export async function resetPlaygroundConversation(input: {
  session: { reset(): Promise<unknown> };
  clear: () => void;
}): Promise<void> {
  await input.session.reset();
  input.clear();
}
