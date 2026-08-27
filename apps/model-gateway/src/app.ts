import { Hono } from "hono";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { ModelListing } from "./registry.js";
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
function sseBody(
  parts: ReadableStream<unknown>,
  onSettled?: () => void,
): ReadableStream<Uint8Array> {
  const reader = parts.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.enqueue(sseData("[DONE]"));
          controller.close();
          onSettled?.();
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
        onSettled?.();
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => undefined);
      onSettled?.();
    },
  });
}

export type ModelGatewayAuthVerdict = boolean | { subject: string };

export type ModelGatewayAppOptions = {
  /**
   * Verifies a bearer token; revocation is "this returns false from now on".
   * Returning `{ subject }` attributes the caller (e.g. "project:<id>") for
   * per-subject concurrency limiting.
   */
  authenticate: (token: string) => ModelGatewayAuthVerdict | Promise<ModelGatewayAuthVerdict>;
  /** Resolves a canonical model id to a live provider-backed model, or undefined. */
  resolveModel: (
    modelId: string,
  ) => LanguageModelV4 | undefined | Promise<LanguageModelV4 | undefined>;
  /** Models advertised on GET /v4/ai/config; defaults to none. */
  listModels?: () => ModelListing[] | Promise<ModelListing[]>;
  /**
   * Per-subject cap on concurrently running model calls, so one project (or
   * personal key) cannot exhaust the platform's shared provider quota.
   * Applies only to attributed callers; absent = uncapped.
   */
  maxConcurrentPerSubject?: number;
};

type ModelGatewayEnv = { Variables: { modelGatewaySubject: string | undefined } };

export function createModelGatewayApp(options: ModelGatewayAppOptions): Hono<ModelGatewayEnv> {
  const app = new Hono<ModelGatewayEnv>();
  const activeBySubject = new Map<string, number>();

  function acquireSlot(subject: string): (() => void) | null {
    const cap = options.maxConcurrentPerSubject;
    if (cap === undefined) return () => undefined;
    const active = activeBySubject.get(subject) ?? 0;
    if (active >= cap) return null;
    activeBySubject.set(subject, active + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = activeBySubject.get(subject) ?? 0;
      if (current <= 1) activeBySubject.delete(subject);
      else activeBySubject.set(subject, current - 1);
    };
  }

  app.get("/health", (context) => context.json({ ok: true }));

  app.use("/v4/ai/*", async (context, next) => {
    const authorization = context.req.header("authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
    const verdict = token === "" ? false : await options.authenticate(token);
    if (verdict === false) {
      return gatewayErrorResponse(
        context,
        401,
        "authentication_error",
        "The provided model gateway token is missing, invalid, or revoked.",
      );
    }
    context.set("modelGatewaySubject", typeof verdict === "object" ? verdict.subject : undefined);
    await next();
  });

  app.get("/v4/ai/config", async (context) =>
    context.json({ models: (await options.listModels?.()) ?? [] }),
  );

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
    const model = await options.resolveModel(modelId);
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

    const subject = context.get("modelGatewaySubject");
    const releaseSlot = subject === undefined ? () => undefined : acquireSlot(subject);
    if (releaseSlot === null) {
      return gatewayErrorResponse(
        context,
        429,
        "rate_limit_exceeded",
        "Too many concurrent model calls for this caller; retry shortly.",
      );
    }

    if (context.req.header(STREAMING_HEADER) === "true") {
      let streamResult: Awaited<ReturnType<LanguageModelV4["doStream"]>>;
      try {
        streamResult = await model.doStream(callOptions);
      } catch {
        releaseSlot();
        return providerFailureResponse(context);
      }
      return new Response(sseBody(streamResult.stream, releaseSlot), {
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
    } finally {
      releaseSlot();
    }
  });

  return app;
}
