import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  MODEL_GATEWAY_ENV,
  MODEL_GATEWAY_KINDS,
  createModelGatewayProvider,
  installModelGateway,
  readModelGatewayConfig,
} from "./model-gateway.ts";

type RecordedRequest = { url: string; headers: IncomingMessage["headers"]; body: any };
type Responder = (request: RecordedRequest, res: ServerResponse) => void;

let server: Server;
let baseURL: string;
let requests: RecordedRequest[];
let respond: Responder;

beforeEach(async () => {
  requests = [];
  respond = (_request, res) => sse(res, [textChunk("hi"), finalChunk({})]);
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const recorded = { url: req.url ?? "", headers: req.headers, body: JSON.parse(raw || "{}") };
      requests.push(recorded);
      respond(recorded, res);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterEach(async () => {
  server.close();
  await once(server, "close");
});

function textChunk(content: string) {
  return {
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model: "m",
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  };
}

function finalChunk(usage: Record<string, unknown>) {
  return {
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model: "m",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, ...usage },
  };
}

function sse(res: ServerResponse, chunks: unknown[], headers: Record<string, string> = {}) {
  res.writeHead(200, { "content-type": "text/event-stream", ...headers });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end("data: [DONE]\n\n");
}

function json(res: ServerResponse, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(200, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function completion(usage: Record<string, unknown>) {
  return {
    id: "c1",
    object: "chat.completion",
    created: 0,
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, ...usage },
  };
}

const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }];

async function streamFinish(kind: "litellm" | "openrouter" | "openai-compatible") {
  const provider = createModelGatewayProvider({ kind, baseURL, apiKey: "sk-project" });
  const model = provider.languageModel("anthropic/claude-sonnet-4.5");
  const { stream } = await model.doStream({ prompt });
  let finish: any;
  for await (const part of stream as unknown as AsyncIterable<any>) {
    if (part.type === "finish") finish = part;
  }
  return finish;
}

async function generate(kind: "litellm" | "openrouter" | "openai-compatible") {
  const provider = createModelGatewayProvider({ kind, baseURL, apiKey: "sk-project" });
  return await provider.languageModel("anthropic/claude-sonnet-4.5").doGenerate({ prompt });
}

describe("readModelGatewayConfig", () => {
  test("is undefined when no kind is configured", () => {
    expect(readModelGatewayConfig({})).toBeUndefined();
  });

  test("reads every supported kind", () => {
    for (const kind of MODEL_GATEWAY_KINDS) {
      const env = {
        [MODEL_GATEWAY_ENV.kind]: kind,
        [MODEL_GATEWAY_ENV.url]: kind === "vercel" ? undefined : "https://gateway.example/v1",
        [MODEL_GATEWAY_ENV.key]: "sk-project",
      };
      expect(readModelGatewayConfig(env)).toMatchObject({ kind, apiKey: "sk-project" });
    }
  });

  test("rejects an unknown kind", () => {
    expect(() =>
      readModelGatewayConfig({ [MODEL_GATEWAY_ENV.kind]: "new-api", [MODEL_GATEWAY_ENV.key]: "k" }),
    ).toThrow(/unsupported Model Gateway kind "new-api"/);
  });

  test("requires a base URL for every kind except vercel", () => {
    expect(() =>
      readModelGatewayConfig({ [MODEL_GATEWAY_ENV.kind]: "litellm", [MODEL_GATEWAY_ENV.key]: "k" }),
    ).toThrow(/EVELAND_MODEL_GATEWAY_URL/);
  });

  test("drops trailing slashes from the base URL, in linear time", () => {
    const slashes = "/".repeat(100_000);
    const read = (url: string) =>
      readModelGatewayConfig({
        [MODEL_GATEWAY_ENV.kind]: "litellm",
        [MODEL_GATEWAY_ENV.url]: url,
        [MODEL_GATEWAY_ENV.key]: "k",
      });
    expect(read(`https://llm.example/v1${slashes}`)).toMatchObject({
      baseURL: "https://llm.example/v1",
    });
    expect(read(`https://llm.example${slashes}x`)).toMatchObject({
      baseURL: `https://llm.example${slashes}x`,
    });
  });

  test("requires a key, without ever echoing configured values", () => {
    let message = "";
    try {
      readModelGatewayConfig({
        [MODEL_GATEWAY_ENV.kind]: "litellm",
        [MODEL_GATEWAY_ENV.url]: "not a url sk-secret",
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/EVELAND_MODEL_GATEWAY_KEY/);
    expect(message).not.toContain("sk-secret");
  });
});

describe("installModelGateway", () => {
  test("leaves the global alone when no Model Gateway is configured", () => {
    const target: Record<string, unknown> = {};
    expect(installModelGateway({ env: {}, target })).toEqual({ status: "not-configured" });
    expect(target).toEqual({});
  });

  test("never replaces a provider the Agent installed itself", () => {
    const own = { languageModel: () => undefined };
    const target: Record<string, unknown> = { AI_SDK_DEFAULT_PROVIDER: own };
    const env = {
      [MODEL_GATEWAY_ENV.kind]: "litellm",
      [MODEL_GATEWAY_ENV.url]: "https://gateway.example/v1",
      [MODEL_GATEWAY_ENV.key]: "sk-project",
    };
    expect(installModelGateway({ env, target })).toEqual({ status: "kept-existing" });
    expect(target.AI_SDK_DEFAULT_PROVIDER).toBe(own);
  });

  test("installs the configured provider as the AI SDK default", async () => {
    const target: Record<string, unknown> = {};
    const env = {
      [MODEL_GATEWAY_ENV.kind]: "litellm",
      [MODEL_GATEWAY_ENV.url]: baseURL,
      [MODEL_GATEWAY_ENV.key]: "sk-project",
    };
    expect(installModelGateway({ env, target })).toEqual({ status: "installed", kind: "litellm" });
    const provider = target.AI_SDK_DEFAULT_PROVIDER as ReturnType<
      typeof createModelGatewayProvider
    >;
    const model = provider.languageModel("anthropic/claude-sonnet-4.5");
    expect(model.provider).toBe("litellm.chat");
    expect(model.modelId).toBe("anthropic/claude-sonnet-4.5");
  });

  test("installs the native AI Gateway provider for the vercel kind", () => {
    const target: Record<string, unknown> = {};
    const env = { [MODEL_GATEWAY_ENV.kind]: "vercel", [MODEL_GATEWAY_ENV.key]: "vck-project" };
    expect(installModelGateway({ env, target })).toEqual({ status: "installed", kind: "vercel" });
    const provider = target.AI_SDK_DEFAULT_PROVIDER as ReturnType<
      typeof createModelGatewayProvider
    >;
    expect(provider.languageModel("anthropic/claude-sonnet-4.5").provider).toBe("gateway");
  });
});

describe("OpenAI-compatible model calls", () => {
  test("forwards the model ID verbatim with the project key and always asks for streamed usage", async () => {
    const finish = await streamFinish("litellm");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("/v1/chat/completions");
    expect(requests[0]!.headers.authorization).toBe("Bearer sk-project");
    expect(requests[0]!.body.model).toBe("anthropic/claude-sonnet-4.5");
    expect(requests[0]!.body.stream_options).toEqual({ include_usage: true });
    expect(finish.usage.inputTokens.total).toBe(10);
    expect(finish.usage.outputTokens.total).toBe(3);
  });

  test.each(["litellm", "openrouter"] as const)(
    "%s: records usage.cost from the final streamed chunk where eve reads cost",
    async (kind) => {
      respond = (_request, res) => sse(res, [textChunk("hi"), finalChunk({ cost: 0.0123 })]);
      const finish = await streamFinish(kind);
      expect(finish.providerMetadata.gateway).toEqual({ cost: 0.0123 });
    },
  );

  test.each(["litellm", "openrouter"] as const)(
    "%s: records usage.cost from a non-streamed body",
    async (kind) => {
      respond = (_request, res) => json(res, completion({ cost: 0.5 }));
      const result = await generate(kind);
      expect(result.providerMetadata?.gateway).toEqual({ cost: 0.5 });
    },
  );

  test("litellm: falls back to the response-cost header when a non-streamed body has no cost", async () => {
    respond = (_request, res) => json(res, completion({}), { "x-litellm-response-cost": "0.0042" });
    const result = await generate("litellm");
    expect(result.providerMetadata?.gateway).toEqual({ cost: 0.0042 });
  });

  test("litellm: ignores a streamed response-cost header, which is sent before usage exists", async () => {
    respond = (_request, res) =>
      sse(res, [textChunk("hi"), finalChunk({})], { "x-litellm-response-cost": "0" });
    const finish = await streamFinish("litellm");
    expect(finish.providerMetadata?.gateway).toBeUndefined();
  });

  test("leaves cost missing when the gateway reports none", async () => {
    respond = (_request, res) => sse(res, [textChunk("hi"), finalChunk({ cost: 0.9 })]);
    const finish = await streamFinish("openai-compatible");
    expect(finish.providerMetadata?.gateway).toBeUndefined();
  });

  test("ignores a cost that is not a finite number", async () => {
    respond = (_request, res) => sse(res, [textChunk("hi"), finalChunk({ cost: "lots" })]);
    const finish = await streamFinish("litellm");
    expect(finish.providerMetadata?.gateway).toBeUndefined();
  });
});
