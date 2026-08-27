import { Hono } from "hono";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import {
  gatewayErrorResponse,
  MODEL_ID_HEADER,
  parseCallOptionsBody,
  providerFailureResponse,
  SPECIFICATION_VERSION_HEADER,
  STREAMING_HEADER,
  SUPPORTED_SPECIFICATION_VERSION,
} from "./protocol.js";

const SSE_ENCODER = new TextEncoder();

function sseData(payload: string): Uint8Array {
  return SSE_ENCODER.encode(`data: ${payload}\n\n`);
}

/**
 * Bridges a provider part stream onto the wire: one SSE `data:` frame per
 * LanguageModelV4StreamPart, `[DONE]` on completion. A mid-stream provider
 * failure becomes an in-band `error` part with a client-safe message instead
 * of a connection reset.
 */
function sseBody(parts: ReadableStream<unknown>): ReadableStream<Uint8Array> {
  const reader = parts.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.enqueue(sseData("[DONE]"));
          controller.close();
          return;
        }
        controller.enqueue(sseData(JSON.stringify(value)));
      } catch {
        controller.enqueue(
          sseData(
            JSON.stringify({ type: "error", error: "The upstream model provider stream failed." }),
          ),
        );
        controller.enqueue(sseData("[DONE]"));
        controller.close();
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => undefined);
    },
  });
}

export type ModelGatewayAppOptions = {
  /** Verifies a bearer token; revocation is "this returns false from now on". */
  authenticate: (token: string) => boolean | Promise<boolean>;
  /** Resolves a canonical model id to a live provider-backed model, or undefined. */
  resolveModel: (modelId: string) => LanguageModelV4 | undefined;
  /** Models advertised on GET /v4/ai/config; defaults to none. */
  listModels?: () => Array<{
    id: string;
    name: string;
    specification: { specificationVersion: "v4"; provider: string; modelId: string };
    modelType: "language";
  }>;
};

export function createModelGatewayApp(options: ModelGatewayAppOptions): Hono {
  const app = new Hono();

  app.get("/health", (context) => context.json({ ok: true }));

  app.use("/v4/ai/*", async (context, next) => {
    const authorization = context.req.header("authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
    if (token === "" || !(await options.authenticate(token))) {
      return gatewayErrorResponse(
        context,
        401,
        "authentication_error",
        "The provided model gateway token is missing, invalid, or revoked.",
      );
    }
    await next();
  });

  app.get("/v4/ai/config", (context) => context.json({ models: options.listModels?.() ?? [] }));

  app.post("/v4/ai/language-model", async (context) => {
    const specificationVersion = context.req.header(SPECIFICATION_VERSION_HEADER);
    if (specificationVersion !== SUPPORTED_SPECIFICATION_VERSION) {
      return gatewayErrorResponse(
        context,
        400,
        "invalid_request_error",
        `Unsupported language model specification version "${specificationVersion ?? ""}"; this gateway speaks version ${SUPPORTED_SPECIFICATION_VERSION}.`,
      );
    }
    const modelId = context.req.header(MODEL_ID_HEADER) ?? "";
    const model = options.resolveModel(modelId);
    if (model === undefined) {
      return gatewayErrorResponse(
        context,
        404,
        "model_not_found",
        `Model "${modelId}" is not available on this model gateway.`,
        { modelId },
      );
    }
    const rawBody = await context.req.json().catch(() => undefined);
    const parsed = parseCallOptionsBody(rawBody);
    if (!parsed.ok) {
      return gatewayErrorResponse(context, 400, "invalid_request_error", parsed.message);
    }
    const callOptions = {
      ...parsed.callOptions,
      abortSignal: context.req.raw.signal,
    } as Parameters<LanguageModelV4["doGenerate"]>[0];

    if (context.req.header(STREAMING_HEADER) === "true") {
      let streamResult: Awaited<ReturnType<LanguageModelV4["doStream"]>>;
      try {
        streamResult = await model.doStream(callOptions);
      } catch {
        return providerFailureResponse(context);
      }
      return new Response(sseBody(streamResult.stream), {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    try {
      const result = await model.doGenerate(callOptions);
      return context.json({
        content: result.content,
        finishReason: result.finishReason,
        usage: result.usage,
        ...(result.providerMetadata === undefined
          ? {}
          : { providerMetadata: result.providerMetadata }),
      });
    } catch {
      return providerFailureResponse(context);
    }
  });

  return app;
}
