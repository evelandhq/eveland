/**
 * HTTP client for a Model Gateway's OpenAI-compatible model list, which the
 * Worker checks an Agent's model IDs against at deploy.
 *
 * Every request goes to an address an admin configured, so the client never
 * follows redirects and always times out. The key never appears in a URL or
 * an error message: failures report only the HTTP status plus the gateway's
 * message with the key masked.
 */

const REQUEST_TIMEOUT_MS = 15_000;

type FetchLike = typeof fetch;

type RequestOptions = {
  url: string;
  bearer: string;
  secrets: readonly string[];
  fetchImpl?: FetchLike;
};

type GatewayResponse = { status: number; body: unknown };

export class ModelGatewayRequestError extends Error {
  /** The gateway's HTTP status, or undefined when no response arrived. */
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ModelGatewayRequestError";
    this.status = status;
  }
}

async function gatewayRequest(options: RequestOptions): Promise<GatewayResponse> {
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(options.url, {
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { authorization: `Bearer ${options.bearer}`, accept: "application/json" },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ModelGatewayRequestError(
      `Model Gateway request failed: ${mask(reason, options.secrets)}`,
    );
  }
  const text = await response.text().catch(() => "");
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    // Keep the raw text for the error message.
  }
  return { status: response.status, body };
}

function failure(response: GatewayResponse, secrets: readonly string[]): ModelGatewayRequestError {
  const detail = gatewayMessage(response.body);
  const suffix = detail ? `: ${mask(detail, secrets).slice(0, 300)}` : "";
  return new ModelGatewayRequestError(
    `Model Gateway responded with HTTP ${response.status}${suffix}`,
    response.status,
  );
}

function gatewayMessage(body: unknown): string {
  if (typeof body === "string") return body;
  if (typeof body !== "object" || body === null) return "";
  const record = body as Record<string, unknown>;
  const error = record.error ?? record.detail;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const nested = error as Record<string, unknown>;
    if (typeof nested.message === "string") return nested.message;
    if (typeof nested.error === "string") return nested.error;
  }
  return typeof record.message === "string" ? record.message : "";
}

function mask(text: string, secrets: readonly string[]): string {
  let masked = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    masked = masked.split(secret).join("[redacted]");
  }
  return masked;
}

function ok(status: number): boolean {
  return status >= 200 && status < 300;
}

/** The model IDs an OpenAI-compatible gateway lists for this key. */
export async function listGatewayModelIds(input: {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: FetchLike;
}): Promise<string[]> {
  const secrets = [input.apiKey];
  const response = await gatewayRequest({
    url: `${trimTrailingSlashes(input.baseUrl)}/models`,
    bearer: input.apiKey,
    secrets,
    fetchImpl: input.fetchImpl,
  });
  if (!ok(response.status)) throw failure(response, secrets);
  const data = (response.body as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(data)) {
    throw new ModelGatewayRequestError("Model Gateway did not return a model list.");
  }
  return data
    .map((entry) => (entry as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === "string");
}

/** Drops trailing slashes without a regex (`/\/+$/` backtracks polynomially). */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}
