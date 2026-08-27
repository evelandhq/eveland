import type { Context } from "hono";

/**
 * Wire constants of the AI SDK Gateway protocol as spoken by the pinned
 * @ai-sdk/gateway client (4.0.59). The server implements this contract; any
 * client-visible change here must stay in lockstep with the pinned client.
 */
export const MODEL_ID_HEADER = "ai-language-model-id";
export const SPECIFICATION_VERSION_HEADER = "ai-language-model-specification-version";
export const STREAMING_HEADER = "ai-language-model-streaming";
export const SUPPORTED_SPECIFICATION_VERSION = "4";

export type GatewayErrorType =
  | "authentication_error"
  | "invalid_request_error"
  | "model_not_found"
  | "not_found"
  | "internal_server_error"
  | "failed_dependency"
  | "forbidden"
  | "rate_limit_exceeded";

export type ParsedCallOptions =
  | { ok: true; callOptions: Record<string, unknown> }
  | { ok: false; message: string };

/**
 * Security contract of the data plane: the agent is an untrusted caller. The
 * body must be a V4 call-options object; client-submitted upstream headers are
 * dropped, and request-scoped gateway routing options (byok, order, only,
 * models, serviceTier, ...) are rejected outright rather than ignored —
 * provider, base URL, and credentials may only come from the server-side
 * registry.
 */
export function parseCallOptionsBody(raw: unknown): ParsedCallOptions {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, message: "The request body must be a call-options JSON object." };
  }
  const body = { ...(raw as Record<string, unknown>) };
  if (!Array.isArray(body.prompt)) {
    return { ok: false, message: "The call options must include a prompt array." };
  }
  delete body.headers;
  delete body.abortSignal;
  const providerOptions = body.providerOptions;
  if (providerOptions !== undefined) {
    if (typeof providerOptions !== "object" || providerOptions === null) {
      return { ok: false, message: "providerOptions must be an object when present." };
    }
    const gatewayOptions = (providerOptions as Record<string, unknown>).gateway;
    if (gatewayOptions !== undefined) {
      const keys =
        typeof gatewayOptions === "object" && gatewayOptions !== null
          ? Object.keys(gatewayOptions)
          : [];
      if (keys.length > 0) {
        return {
          ok: false,
          message: `Request-scoped gateway options are not supported on this model gateway: ${keys.join(", ")}.`,
        };
      }
      const { gateway: _gateway, ...rest } = providerOptions as Record<string, unknown>;
      body.providerOptions = rest;
    }
  }
  return { ok: true, callOptions: body };
}

/** Maps an upstream provider failure to a client-safe gateway error. */
export function providerFailureResponse(context: Context): Response {
  return gatewayErrorResponse(
    context,
    502,
    "internal_server_error",
    "The upstream model provider request failed.",
  );
}

export function gatewayErrorResponse(
  context: Context,
  status: 400 | 401 | 403 | 404 | 424 | 429 | 500 | 502,
  type: GatewayErrorType,
  message: string,
  param?: Record<string, unknown>,
): Response {
  return context.json(
    { error: { message, type, ...(param === undefined ? {} : { param }) } },
    status,
  );
}
