/**
 * The control panel's one browser transport. Every client-side call goes
 * through here so the API's error contract is decoded once, the base URL has
 * a single definition, and session expiry has one policy instead of each
 * component inventing its own.
 */

import { API_ORIGIN_FALLBACK } from "@evelandhq/core/ports";

export const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? API_ORIGIN_FALLBACK;

/**
 * The complete control-plane error contract. Validation failures carry
 * `issues` (a field-level message the user can act on), so the decoder
 * prefers those over the generic line -- previously only the new-project path
 * read them, and the same failure through the shared client degraded to
 * "Invalid request".
 */
export async function decodeApiError(
  response: Response,
  fallback = `Request failed with ${response.status}`,
): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: string;
      detail?: string;
      message?: string;
      issues?: Array<{ message?: string }>;
    };
    return (
      body.detail ??
      body.issues?.find((issue) => issue.message)?.message ??
      body.error ??
      body.message ??
      fallback
    );
  } catch {
    return fallback;
  }
}

/**
 * A session that expired mid-interaction. Callers that render errors show the
 * message; the transport has already started the redirect back to login, so
 * the user lands somewhere they can act instead of on a dead error string.
 */
export class ApiUnauthorizedError extends Error {
  constructor() {
    super("Your session expired. Redirecting to sign in…");
    this.name = "ApiUnauthorizedError";
  }
}

function redirectToLogin(): void {
  if (typeof window === "undefined") return;
  const next = `${window.location.pathname}${window.location.search}`;
  const target = `/login?next=${encodeURIComponent(next)}`;
  // Guard against a redirect loop when the login page itself 401s.
  if (window.location.pathname.startsWith("/login")) return;
  window.location.assign(target);
}

export type ApiRequestOptions = RequestInit & {
  /** Treat 404 as an absent resource instead of an error. */
  optional?: boolean;
  /**
   * What a 401 means for this call. "redirect" (the default) reads it as an
   * expired session and sends the user back to sign in. "surface" reads it as
   * the endpoint's answer -- authentication routes reject a credential with
   * 401, and the caller needs that message, not a session-expiry line, with
   * nowhere to redirect to since the user is already signing in.
   */
  unauthorized?: "redirect" | "surface";
};

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${apiBaseUrl}${path}`, { credentials: "include", ...init });
}

export async function apiRequest<T = unknown>(
  path: string,
  options: ApiRequestOptions & { optional: true },
): Promise<T | null>;
export async function apiRequest<T = unknown>(
  path: string,
  options?: ApiRequestOptions,
): Promise<T>;
export async function apiRequest<T = unknown>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T | null> {
  const { optional, unauthorized = "redirect", ...init } = options;
  const response = await apiFetch(path, init);
  if (response.status === 401 && unauthorized === "redirect") {
    redirectToLogin();
    throw new ApiUnauthorizedError();
  }
  if (optional && response.status === 404) return null;
  if (response.status === 204) return undefined as T;
  if (!response.ok) throw new Error(await decodeApiError(response));
  return (await response.json().catch(() => ({}))) as T;
}
