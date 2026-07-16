import type { UserContent } from "ai";

export type PendingPlaygroundMessage = string | UserContent;

type StorageLike = Pick<Storage, "getItem" | "removeItem" | "setItem">;

type RouteAuthInteraction = {
  type: "redirect";
  url: string;
};

type RouteAuthErrorInput = {
  error: unknown;
  message: PendingPlaygroundMessage | null;
  projectId: string;
  redirect: (url: string) => void;
  storage: StorageLike;
};

export function interactionFromClientError(error: unknown): RouteAuthInteraction | null {
  if (
    typeof error !== "object"
    || error === null
    || !("status" in error)
    || error.status !== 401
    || !("body" in error)
    || typeof error.body !== "string"
  ) {
    return null;
  }
  try {
    const body = JSON.parse(error.body) as {
      code?: unknown;
      interaction?: { type?: unknown; url?: unknown };
    };
    if (
      body.code !== "interaction_required"
      || body.interaction?.type !== "redirect"
      || typeof body.interaction.url !== "string"
      || !body.interaction.url.startsWith("/api/eveland/")
    ) {
      return null;
    }
    return { type: "redirect", url: body.interaction.url };
  } catch {
    return null;
  }
}

export function savePendingPlaygroundTurn(
  storage: StorageLike,
  projectId: string,
  message: PendingPlaygroundMessage,
): void {
  storage.setItem(storageKey(projectId), JSON.stringify({ version: 1, message }));
}

export function handleRouteAuthError({
  error,
  message,
  projectId,
  redirect,
  storage,
}: RouteAuthErrorInput): boolean {
  if (message === null) return false;
  const interaction = interactionFromClientError(error);
  if (!interaction) return false;
  savePendingPlaygroundTurn(storage, projectId, message);
  redirect(interaction.url);
  return true;
}

export function claimPendingPlaygroundTurn(
  storage: StorageLike,
  projectId: string,
): PendingPlaygroundMessage | null {
  const key = storageKey(projectId);
  const serialized = storage.getItem(key);
  if (!serialized) return null;
  storage.removeItem(key);
  try {
    const value = JSON.parse(serialized) as { version?: unknown; message?: unknown };
    if (value.version !== 1 || (typeof value.message !== "string" && !Array.isArray(value.message))) return null;
    return value.message as PendingPlaygroundMessage;
  } catch {
    return null;
  }
}

function storageKey(projectId: string): string {
  return `eveland:playground:pending-route-auth:${projectId}`;
}
