import { createHash } from "node:crypto";

import type { ModelGatewayKind } from "../model-gateway.js";

/**
 * HTTP client for the Model Gateway management surface: LiteLLM's key
 * management API (issue, look up, rotate, revoke per-project keys), the
 * OpenAI-compatible model list, and the admin's connection test.
 *
 * Every request goes to an address an admin configured, so the client never
 * follows redirects and always times out. No key or credential ever appears
 * in a URL or in an error message: LiteLLM accepts a key's sha256 hash
 * wherever a key identifies a resource, and failures report only the HTTP
 * status plus the gateway's message with every secret in play masked.
 */

const REQUEST_TIMEOUT_MS = 15_000;

type FetchLike = typeof fetch;

type RequestOptions = {
  method?: "GET" | "POST";
  url: string;
  bearer: string;
  body?: unknown;
  secrets: readonly string[];
  fetchImpl?: FetchLike;
};

type GatewayResponse = { status: number; body: unknown };

export class ModelGatewayRequestError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ModelGatewayRequestError";
    this.status = status;
  }
}

/** LiteLLM stores, and looks keys up by, the sha256 hex digest of the key. */
export function hashLiteLlmKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * The configured base URL is the OpenAI-compatible one (`.../v1`) that Agents
 * call; LiteLLM's management routes sit at the proxy root.
 */
export function liteLlmManagementRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

async function gatewayRequest(options: RequestOptions): Promise<GatewayResponse> {
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(options.url, {
      method: options.method ?? "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${options.bearer}`,
        accept: "application/json",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
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
    const hashed = hashLiteLlmKey(secret);
    masked = masked.split(hashed).join("[redacted]");
  }
  return masked;
}

function ok(status: number): boolean {
  return status >= 200 && status < 300;
}

export type LiteLlmCall = { baseUrl: string; adminKey: string; fetchImpl?: FetchLike };

/**
 * Registers a key whose value Eveland generated and stored first, so a crash
 * after the gateway accepted it never loses the only copy.
 */
export async function generateLiteLlmKey(
  input: LiteLlmCall & { key: string; alias: string; metadata?: Record<string, string> },
): Promise<{ status: "created" } | { status: "alias-taken" }> {
  const secrets = [input.adminKey, input.key];
  const response = await gatewayRequest({
    method: "POST",
    url: `${liteLlmManagementRoot(input.baseUrl)}/key/generate`,
    bearer: input.adminKey,
    body: {
      key: input.key,
      key_alias: input.alias,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    },
    secrets,
    fetchImpl: input.fetchImpl,
  });
  if (ok(response.status)) return { status: "created" };
  if (response.status === 400 && /alias .* already exists/i.test(gatewayMessage(response.body))) {
    return { status: "alias-taken" };
  }
  throw failure(response, secrets);
}

export async function liteLlmKeyExists(input: LiteLlmCall & { key: string }): Promise<boolean> {
  const secrets = [input.adminKey, input.key];
  const response = await gatewayRequest({
    url: `${liteLlmManagementRoot(input.baseUrl)}/key/info?key=${hashLiteLlmKey(input.key)}`,
    bearer: input.adminKey,
    secrets,
    fetchImpl: input.fetchImpl,
  });
  if (ok(response.status)) return true;
  if (response.status === 404) return false;
  throw failure(response, secrets);
}

/** Replaces a key with a new value; the old one keeps working for `gracePeriod`. */
export async function regenerateLiteLlmKey(
  input: LiteLlmCall & { key: string; newKey: string; gracePeriod: string },
): Promise<void> {
  const secrets = [input.adminKey, input.key, input.newKey];
  const response = await gatewayRequest({
    method: "POST",
    url: `${liteLlmManagementRoot(input.baseUrl)}/key/${hashLiteLlmKey(input.key)}/regenerate`,
    bearer: input.adminKey,
    body: { new_key: input.newKey, grace_period: input.gracePeriod },
    secrets,
    fetchImpl: input.fetchImpl,
  });
  if (!ok(response.status)) throw failure(response, secrets);
}

/**
 * Revokes a key. LiteLLM answers 400 "Not all keys passed in were deleted"
 * for a key that is already gone, which a retried revocation must accept.
 */
export async function deleteLiteLlmKey(
  input: LiteLlmCall & { key: string },
): Promise<{ status: "deleted" | "not-found" }> {
  const secrets = [input.adminKey, input.key];
  const response = await gatewayRequest({
    method: "POST",
    url: `${liteLlmManagementRoot(input.baseUrl)}/key/delete`,
    bearer: input.adminKey,
    body: { keys: [hashLiteLlmKey(input.key)] },
    secrets,
    fetchImpl: input.fetchImpl,
  });
  if (ok(response.status)) return { status: "deleted" };
  if (response.status === 404) return { status: "not-found" };
  if (
    response.status === 400 &&
    /not all keys passed in were deleted/i.test(gatewayMessage(response.body))
  ) {
    return { status: "not-found" };
  }
  throw failure(response, secrets);
}

/** The model IDs an OpenAI-compatible gateway lists for this key. */
export async function listGatewayModelIds(input: {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: FetchLike;
}): Promise<string[]> {
  const secrets = [input.apiKey];
  const response = await gatewayRequest({
    url: `${input.baseUrl.replace(/\/+$/, "")}/models`,
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

export type ModelGatewayConnectionResult =
  | { ok: true; modelCount?: number }
  | { ok: false; error: string };

const VERCEL_AI_GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1";

/**
 * The admin's "Test connection": a LiteLLM management credential is checked
 * against `/key/info` (its own key), any other credential by listing models.
 */
export async function testModelGatewayConnection(input: {
  kind: ModelGatewayKind;
  baseUrl: string | null;
  credential: string;
  fetchImpl?: FetchLike;
}): Promise<ModelGatewayConnectionResult> {
  try {
    if (input.kind === "litellm") {
      if (!input.baseUrl) return { ok: false, error: "A LiteLLM gateway needs a base URL." };
      const response = await gatewayRequest({
        url: `${liteLlmManagementRoot(input.baseUrl)}/key/info`,
        bearer: input.credential,
        secrets: [input.credential],
        fetchImpl: input.fetchImpl,
      });
      if (!ok(response.status)) throw failure(response, [input.credential]);
      return { ok: true };
    }
    const models = await listGatewayModelIds({
      baseUrl: input.kind === "vercel" ? VERCEL_AI_GATEWAY_MODELS_URL : (input.baseUrl ?? ""),
      apiKey: input.credential,
      fetchImpl: input.fetchImpl,
    });
    return { ok: true, modelCount: models.length };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
