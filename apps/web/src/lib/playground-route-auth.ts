import type { UserContent } from "ai";
import type { ClientSessionState } from "eve/client";

export type PendingPlaygroundMessage = string | UserContent;

export type PendingPlaygroundTurn = {
  message: PendingPlaygroundMessage;
  /**
   * Durable session that existed when the redirect left the page. Present so
   * the return path can replay the conversation with the hook's native
   * `resume()` before re-sending the message; absent on a first turn, where
   * there is nothing to resume.
   */
  session?: ClientSessionState;
};

type StorageLike = Pick<Storage, "getItem" | "removeItem" | "setItem">;

type RouteAuthInteraction = { type: "redirect"; url: string };

export function interactionFromClientError(error: unknown): RouteAuthInteraction | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("status" in error) ||
    error.status !== 401 ||
    !("body" in error) ||
    typeof error.body !== "string"
  )
    return null;
  try {
    const body = JSON.parse(error.body) as {
      code?: unknown;
      interaction?: { type?: unknown; url?: unknown };
    };
    if (
      body.code !== "interaction_required" ||
      body.interaction?.type !== "redirect" ||
      typeof body.interaction.url !== "string" ||
      !body.interaction.url.startsWith("/api/")
    )
      return null;
    return { type: "redirect", url: body.interaction.url };
  } catch {
    return null;
  }
}

export function handleRouteAuthError(input: {
  error: unknown;
  message: PendingPlaygroundMessage | null;
  session: ClientSessionState | undefined;
  projectId: string;
  redirect(url: string): void;
  storage: StorageLike;
}): boolean {
  if (input.message === null) return false;
  const interaction = interactionFromClientError(input.error);
  if (!interaction) return false;
  input.storage.setItem(
    storageKey(input.projectId),
    JSON.stringify({ version: 1, message: input.message, session: input.session }),
  );
  input.redirect(interaction.url);
  return true;
}

/**
 * Reads the pending turn without consuming it. Safe to call during render:
 * the destructive claim stays in an effect, where a ref guards it against
 * StrictMode's double invocation.
 */
export function peekPendingPlaygroundTurn(
  storage: StorageLike,
  projectId: string,
): PendingPlaygroundTurn | null {
  const serialized = storage.getItem(storageKey(projectId));
  if (!serialized) return null;
  return parsePendingTurn(serialized);
}

export function claimPendingPlaygroundTurn(
  storage: StorageLike,
  projectId: string,
): PendingPlaygroundTurn | null {
  const key = storageKey(projectId);
  const serialized = storage.getItem(key);
  if (!serialized) return null;
  storage.removeItem(key);
  return parsePendingTurn(serialized);
}

function parsePendingTurn(serialized: string): PendingPlaygroundTurn | null {
  try {
    const value = JSON.parse(serialized) as {
      version?: unknown;
      message?: unknown;
      session?: unknown;
    };
    if (value.version !== 1 || (typeof value.message !== "string" && !Array.isArray(value.message)))
      return null;
    return {
      message: value.message as PendingPlaygroundMessage,
      session: clientSessionState(value.session),
    };
  } catch {
    return null;
  }
}

function clientSessionState(value: unknown): ClientSessionState | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("sessionId" in value) ||
    typeof value.sessionId !== "string" ||
    !("streamIndex" in value) ||
    typeof value.streamIndex !== "number"
  )
    return undefined;
  return { sessionId: value.sessionId, streamIndex: value.streamIndex };
}

function storageKey(projectId: string): string {
  return `eveland:playground:pending-route-auth:${projectId}`;
}
