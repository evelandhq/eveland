import { expect, test } from "vitest";
import {
  fakeModel,
  protocolHeaders,
  registerModelGatewayTestCleanup,
  startModelGateway,
} from "./app.test-support.js";

registerModelGatewayTestCleanup();

const userPrompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }];

function hangingModel() {
  let releaseAll: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    releaseAll = resolve;
  });
  const { model } = fakeModel({
    doGenerate: async () => {
      await gate;
      return {
        content: [{ type: "text", text: "done" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  return { model, releaseAll };
}

async function callGateway(baseURL: string, token: string): Promise<Response> {
  return fetch(`${baseURL}/language-model`, {
    method: "POST",
    headers: protocolHeaders({ authorization: `Bearer ${token}` }),
    body: JSON.stringify({ prompt: userPrompt }),
  });
}

test("a subject exceeding its concurrency cap gets 429 while other subjects are unaffected", async () => {
  const { model, releaseAll } = hangingModel();
  const { baseURL } = await startModelGateway({
    authenticate: (token) =>
      token.startsWith("proj-a") ? { subject: "project:a" } : { subject: "project:b" },
    resolveModel: () => model,
    maxConcurrentPerSubject: 2,
  });

  const first = callGateway(baseURL, "proj-a-1");
  const second = callGateway(baseURL, "proj-a-2");
  // Give the two hanging calls time to occupy their slots.
  await new Promise((resolve) => setTimeout(resolve, 100));

  const third = await callGateway(baseURL, "proj-a-3");
  expect(third.status).toBe(429);
  const body = (await third.json()) as { error: { type: string } };
  expect(body.error.type).toBe("rate_limit_exceeded");

  // A different subject still has its own budget.
  const other = callGateway(baseURL, "proj-b-1");
  await new Promise((resolve) => setTimeout(resolve, 50));

  releaseAll();
  expect((await first).status).toBe(200);
  expect((await second).status).toBe(200);
  expect((await other).status).toBe(200);

  // Slots free up after completion.
  const fourth = await callGateway(baseURL, "proj-a-4");
  expect(fourth.status).toBe(200);
});
