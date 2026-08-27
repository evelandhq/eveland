import { createGateway } from "@ai-sdk/gateway";
import { expect, test } from "vitest";
import {
  fakeModel,
  partsToStream,
  protocolHeaders,
  registerModelGatewayTestCleanup,
  startModelGateway,
  TEST_TOKEN,
} from "./app.test-support.js";

registerModelGatewayTestCleanup();

const userPrompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }];

test("rejects a request without a bearer token", async () => {
  const { baseURL } = await startModelGateway({
    authenticate: () => true,
    resolveModel: () => fakeModel().model,
  });
  const response = await fetch(`${baseURL}/language-model`, {
    method: "POST",
    headers: protocolHeaders({ authorization: "" }),
    body: JSON.stringify({ prompt: userPrompt }),
  });
  expect(response.status).toBe(401);
  const body = (await response.json()) as { error: { type: string; message: string } };
  expect(body.error.type).toBe("authentication_error");
});

test("rejects a token the authenticator does not accept", async () => {
  const { baseURL } = await startModelGateway({
    authenticate: (token) => token === "some-other-token",
    resolveModel: () => fakeModel().model,
  });
  const response = await fetch(`${baseURL}/language-model`, {
    method: "POST",
    headers: protocolHeaders(),
    body: JSON.stringify({ prompt: userPrompt }),
  });
  expect(response.status).toBe(401);
  const body = (await response.json()) as { error: { type: string } };
  expect(body.error.type).toBe("authentication_error");
});

test("rejects a specification version other than 4", async () => {
  const { baseURL } = await startModelGateway({
    authenticate: () => true,
    resolveModel: () => fakeModel().model,
  });
  const response = await fetch(`${baseURL}/language-model`, {
    method: "POST",
    headers: protocolHeaders({ "ai-language-model-specification-version": "3" }),
    body: JSON.stringify({ prompt: userPrompt }),
  });
  expect(response.status).toBe(400);
  const body = (await response.json()) as { error: { type: string } };
  expect(body.error.type).toBe("invalid_request_error");
});

test("rejects a body that is not a call-options object", async () => {
  const { baseURL } = await startModelGateway({
    authenticate: () => true,
    resolveModel: () => fakeModel().model,
  });
  const response = await fetch(`${baseURL}/language-model`, {
    method: "POST",
    headers: protocolHeaders(),
    body: JSON.stringify({ notPrompt: true }),
  });
  expect(response.status).toBe(400);
  const body = (await response.json()) as { error: { type: string } };
  expect(body.error.type).toBe("invalid_request_error");
});

test("accepts eve's own gateway caching hint and strips it before the provider", async () => {
  // eve's runtime sends providerOptions.gateway.caching = "auto" with every
  // string-model call; rejecting it would break every real agent. For a BYOK
  // direct call the hint is meaningless, so it is accepted and stripped —
  // deliberately, as a supported option, unlike the rejected routing options.
  const { model, calls } = fakeModel();
  const { baseURL } = await startModelGateway({
    authenticate: () => true,
    resolveModel: () => model,
  });
  const response = await fetch(`${baseURL}/language-model`, {
    method: "POST",
    headers: protocolHeaders(),
    body: JSON.stringify({
      prompt: userPrompt,
      providerOptions: { gateway: { caching: "auto" }, anthropic: { keep: true } },
    }),
  });
  expect(response.status).toBe(200);
  expect(calls.generate).toHaveLength(1);
  expect(calls.generate[0]?.providerOptions).toEqual({ anthropic: { keep: true } });
});

test("rejects request-scoped gateway provider options such as byok", async () => {
  const { model, calls } = fakeModel();
  const { baseURL } = await startModelGateway({
    authenticate: () => true,
    resolveModel: () => model,
  });
  for (const gatewayOptions of [
    { byok: { openai: [{ apiKey: "sk-evil" }] } },
    { order: ["evil"] },
  ]) {
    const response = await fetch(`${baseURL}/language-model`, {
      method: "POST",
      headers: protocolHeaders(),
      body: JSON.stringify({ prompt: userPrompt, providerOptions: { gateway: gatewayOptions } }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("invalid_request_error");
  }
  expect(calls.generate).toHaveLength(0);
});

test("strips client-submitted headers before the call reaches the provider model", async () => {
  const { model, calls } = fakeModel();
  const { baseURL } = await startModelGateway({
    authenticate: () => true,
    resolveModel: () => model,
  });
  const response = await fetch(`${baseURL}/language-model`, {
    method: "POST",
    headers: protocolHeaders(),
    body: JSON.stringify({
      prompt: userPrompt,
      headers: { authorization: "Bearer forged-upstream-credential" },
    }),
  });
  expect(response.status).toBe(200);
  expect(calls.generate).toHaveLength(1);
  expect(calls.generate[0]).not.toHaveProperty("headers");
  expect(calls.generate[0]?.prompt).toEqual(userPrompt);
  expect(calls.generate[0]?.abortSignal).toBeInstanceOf(AbortSignal);
});

test("returns provider metadata and usage through the real gateway client", async () => {
  const { model } = fakeModel({
    doGenerate: async () => ({
      content: [{ type: "text", text: "hello from provider" }],
      finishReason: { unified: "stop", raw: "end_turn" },
      usage: {
        inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 4, text: 4, reasoning: 0 },
      },
      providerMetadata: { fake: { requestId: "req_1" } },
      warnings: [],
    }),
  });
  const { baseURL } = await startModelGateway({
    authenticate: () => true,
    resolveModel: () => model,
  });
  const gateway = createGateway({ baseURL, apiKey: TEST_TOKEN });
  const result = await gateway
    .languageModel("zai/glm-5.3-flash")
    .doGenerate({ prompt: userPrompt });
  expect(result.content).toEqual([{ type: "text", text: "hello from provider" }]);
  expect(result.usage.inputTokens.total).toBe(11);
  expect(result.finishReason).toEqual({ unified: "stop", raw: "end_turn" });
  expect(result.providerMetadata).toEqual({ fake: { requestId: "req_1" } });
});

test("an unknown model surfaces as GatewayModelNotFoundError through the client", async () => {
  const { baseURL } = await startModelGateway({
    authenticate: () => true,
    resolveModel: () => undefined,
  });
  const gateway = createGateway({ baseURL, apiKey: TEST_TOKEN });
  await expect(
    gateway.languageModel("nobody/no-model").doGenerate({ prompt: userPrompt }),
  ).rejects.toMatchObject({ name: "GatewayModelNotFoundError", statusCode: 404 });
});

test("maps an upstream provider failure to a gateway error without leaking details", async () => {
  const upstreamError = Object.assign(new Error("upstream exploded: secret sk-live-123"), {
    statusCode: 500,
    url: "https://api.upstream.example/chat/completions",
  });
  const { model } = fakeModel({
    doGenerate: async () => {
      throw upstreamError;
    },
  });
  const { baseURL } = await startModelGateway({
    authenticate: () => true,
    resolveModel: () => model,
  });
  const response = await fetch(`${baseURL}/language-model`, {
    method: "POST",
    headers: protocolHeaders(),
    body: JSON.stringify({ prompt: userPrompt }),
  });
  expect(response.status).toBe(502);
  const body = (await response.json()) as { error: { type: string; message: string } };
  expect(body.error.type).toBe("internal_server_error");
  expect(body.error.message).not.toContain("sk-live-123");
  expect(body.error.message).not.toContain("api.upstream.example");
});

async function collectStreamParts(
  stream: ReadableStream<unknown>,
): Promise<Array<Record<string, unknown>>> {
  const parts: Array<Record<string, unknown>> = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value as Record<string, unknown>);
  }
  return parts;
}

test("streams provider stream parts verbatim through the real gateway client", async () => {
  const { model, calls } = fakeModel();
  const { baseURL } = await startModelGateway({
    authenticate: () => true,
    resolveModel: () => model,
  });
  const gateway = createGateway({ baseURL, apiKey: TEST_TOKEN });
  const { stream } = await gateway
    .languageModel("zai/glm-5.3-flash")
    .doStream({ prompt: userPrompt });
  const parts = await collectStreamParts(stream);
  expect(calls.stream).toHaveLength(1);
  expect(parts.map((part) => part.type)).toEqual([
    "text-start",
    "text-delta",
    "text-delta",
    "text-end",
    "finish",
  ]);
  const finish = parts.at(-1) as { usage: { outputTokens: { total: number } } };
  expect(finish.usage.outputTokens.total).toBe(5);
});

test("streams response-metadata with a timestamp the client revives as a Date", async () => {
  const { model } = fakeModel({
    doStream: async () => ({
      stream: partsToStream([
        {
          type: "response-metadata",
          id: "resp_1",
          modelId: "glm-5.3-flash",
          timestamp: "2026-08-27T00:00:00.000Z" as unknown as Date,
        },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        },
      ]),
    }),
  });
  const { baseURL } = await startModelGateway({
    authenticate: () => true,
    resolveModel: () => model,
  });
  const gateway = createGateway({ baseURL, apiKey: TEST_TOKEN });
  const { stream } = await gateway
    .languageModel("zai/glm-5.3-flash")
    .doStream({ prompt: userPrompt });
  const parts = await collectStreamParts(stream);
  const metadata = parts.find((part) => part.type === "response-metadata") as {
    timestamp: unknown;
  };
  expect(metadata.timestamp).toBeInstanceOf(Date);
});

test("propagates client abort to the provider model during a stream", async () => {
  let providerSignal: AbortSignal | undefined;
  const { model } = fakeModel({
    doStream: async (streamOptions) => {
      providerSignal = streamOptions.abortSignal;
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-start", id: "t1" });
            // Never closes: the only way out is cancellation.
          },
        }),
      };
    },
  });
  const { baseURL } = await startModelGateway({
    authenticate: () => true,
    resolveModel: () => model,
  });
  const gateway = createGateway({ baseURL, apiKey: TEST_TOKEN });
  const abortController = new AbortController();
  const { stream } = await gateway
    .languageModel("zai/glm-5.3-flash")
    .doStream({ prompt: userPrompt, abortSignal: abortController.signal });
  const reader = stream.getReader();
  await reader.read();
  expect(providerSignal?.aborted).toBe(false);
  abortController.abort();
  await expect.poll(() => providerSignal?.aborted, { timeout: 5000 }).toBe(true);
});

test("a provider failure before the stream starts surfaces as a gateway error", async () => {
  const { model } = fakeModel({
    doStream: async () => {
      throw new Error("connect ECONNREFUSED upstream");
    },
  });
  const { baseURL } = await startModelGateway({
    authenticate: () => true,
    resolveModel: () => model,
  });
  const gateway = createGateway({ baseURL, apiKey: TEST_TOKEN });
  await expect(
    gateway.languageModel("zai/glm-5.3-flash").doStream({ prompt: userPrompt }),
  ).rejects.toMatchObject({ statusCode: 502 });
});

test("a revoked token is rejected on the next request through the real gateway client", async () => {
  const validTokens = new Set([TEST_TOKEN]);
  const { model } = fakeModel();
  const { baseURL } = await startModelGateway({
    authenticate: (token) => validTokens.has(token),
    resolveModel: () => model,
  });
  const gateway = createGateway({ baseURL, apiKey: TEST_TOKEN });
  const languageModel = gateway.languageModel("zai/glm-5.3-flash");

  const first = await languageModel.doGenerate({ prompt: userPrompt });
  expect(first.content).toEqual([{ type: "text", text: "fake generation" }]);

  validTokens.delete(TEST_TOKEN);

  await expect(languageModel.doGenerate({ prompt: userPrompt })).rejects.toMatchObject({
    name: "GatewayAuthenticationError",
    statusCode: 401,
  });
});

test("tool definitions and tool-call stream parts ride the wire unchanged", async () => {
  const { model, calls } = fakeModel({
    doStream: async (streamOptions) => {
      calls.stream.push(streamOptions);
      return {
        stream: partsToStream([
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "get_weather",
            input: JSON.stringify({ city: "Xi'an" }),
          },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool_calls" },
            usage: {
              inputTokens: { total: 9, noCache: 9, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 2, text: 0, reasoning: 0 },
            },
          },
        ]),
      };
    },
  });
  const { baseURL } = await startModelGateway({
    authenticate: () => true,
    resolveModel: () => model,
  });
  const gateway = createGateway({ baseURL, apiKey: TEST_TOKEN });
  const tools = [
    {
      type: "function" as const,
      name: "get_weather",
      description: "Get the weather",
      inputSchema: {
        type: "object" as const,
        properties: { city: { type: "string" as const } },
        required: ["city"],
      },
    },
  ];
  const { stream } = await gateway.languageModel("zai/glm-5.3-flash").doStream({
    prompt: userPrompt,
    tools,
    toolChoice: { type: "auto" },
  });
  const parts = await collectStreamParts(stream);

  expect(calls.stream.at(-1)?.tools).toEqual(tools);
  expect(calls.stream.at(-1)?.toolChoice).toEqual({ type: "auto" });
  const toolCall = parts.find((part) => part.type === "tool-call");
  expect(toolCall).toMatchObject({ toolCallId: "call_1", toolName: "get_weather" });
  const finish = parts.at(-1) as { finishReason: { unified: string } };
  expect(finish.finishReason.unified).toBe("tool-calls");
});
