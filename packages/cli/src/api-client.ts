/**
 * The CLI's HTTP seam: the public /api contract only — the same one the
 * browser Dashboard uses. Injectable fetch keeps every command testable
 * without a network.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export async function apiRequest<T>(input: {
  origin: string;
  path: string;
  method?: string;
  token?: string;
  json?: unknown;
  form?: Record<string, string>;
  fetchImpl?: FetchLike;
}): Promise<T> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (input.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(input.form).toString();
  } else if (input.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(input.json);
  }
  if (input.token) headers.authorization = `Bearer ${input.token}`;
  const response = await fetchImpl(`${input.origin}${input.path}`, {
    method: input.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    body,
  });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new ApiError(
      describeApiError(response.status, payload),
      response.status,
      apiErrorCode(payload),
    );
  }
  return payload as T;
}

/** The OAuth-style `error` code, when the body carries one. */
export function apiErrorCode(payload: Record<string, unknown> | null): string | null {
  return typeof payload?.error === "string" ? payload.error : null;
}

function describeApiError(status: number, payload: Record<string, unknown> | null): string {
  const description =
    typeof payload?.error_description === "string" ? payload.error_description : null;
  const error = apiErrorCode(payload);
  return description ?? error ?? `Request failed with status ${status}.`;
}
