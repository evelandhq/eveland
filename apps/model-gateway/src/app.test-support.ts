import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { afterEach } from "vitest";
import { createModelGatewayApp, type ModelGatewayAppOptions } from "./app.js";

export const TEST_TOKEN = "test-model-gateway-runtime-token";

const gatewayServers: Array<ReturnType<typeof serve>> = [];
const upstreamServers: Server[] = [];

export function registerModelGatewayTestCleanup(): void {
  afterEach(async () => {
    await Promise.all(
      gatewayServers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    await Promise.all(
      upstreamServers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });
}

export async function startModelGateway(
  options: ModelGatewayAppOptions,
): Promise<{ origin: string; baseURL: string }> {
  const app = createModelGatewayApp(options);
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  gatewayServers.push(server);
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, baseURL: `${origin}/v4/ai` };
}

export function partsToStream(
  parts: LanguageModelV4StreamPart[],
): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

export type FakeModelCalls = {
  generate: LanguageModelV4CallOptions[];
  stream: LanguageModelV4CallOptions[];
};

export function fakeModel(overrides?: Partial<LanguageModelV4>): {
  model: LanguageModelV4;
  calls: FakeModelCalls;
} {
  const calls: FakeModelCalls = { generate: [], stream: [] };
  const model: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: "fake",
    modelId: "fake-model",
    supportedUrls: {},
    doGenerate: async (options) => {
      calls.generate.push(options);
      return {
        content: [{ type: "text", text: "fake generation" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      };
    },
    doStream: async (options) => {
      calls.stream.push(options);
      return {
        stream: partsToStream([
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "fake " },
          { type: "text-delta", id: "t1", delta: "stream" },
          { type: "text-end", id: "t1" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 5, text: 5, reasoning: 0 },
            },
          },
        ]),
      };
    },
    ...overrides,
  };
  return { model, calls };
}

export function protocolHeaders(overrides?: Record<string, string>): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${TEST_TOKEN}`,
    "ai-language-model-id": "zai/glm-5.3-flash",
    "ai-language-model-specification-version": "4",
    "ai-language-model-streaming": "false",
    ...overrides,
  };
}

export type UpstreamRecording = {
  requests: Array<{ headers: IncomingMessage["headers"]; body: unknown }>;
};

/**
 * Minimal OpenAI-compatible upstream: POST /chat/completions answering either
 * JSON or SSE depending on the request's `stream` flag, while recording every
 * request so tests can assert exactly what crossed the provider boundary.
 */
export async function startOpenAiCompatibleUpstream(): Promise<{
  origin: string;
  recording: UpstreamRecording;
}> {
  const recording: UpstreamRecording = { requests: [] };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        stream?: boolean;
        model?: string;
      };
      recording.requests.push({ headers: request.headers, body });
      if (body.stream === true) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const events = [
          {
            id: "cmpl-1",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [{ index: 0, delta: { role: "assistant", content: "upstream " } }],
          },
          {
            id: "cmpl-1",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [{ index: 0, delta: { content: "stream" }, finish_reason: "stop" }],
          },
          {
            id: "cmpl-1",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [],
            usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
          },
        ];
        for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.write("data: [DONE]\n\n");
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "cmpl-1",
          object: "chat.completion",
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "upstream generation" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
        }),
      );
    });
  });
  upstreamServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, recording };
}
