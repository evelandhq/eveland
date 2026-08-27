import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test, vi } from "vitest";

type GlobalWithProvider = typeof globalThis & { AI_SDK_DEFAULT_PROVIDER?: unknown };

const servers: Server[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  delete (globalThis as GlobalWithProvider).AI_SDK_DEFAULT_PROVIDER;
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function importRegisterFresh(): Promise<void> {
  vi.resetModules();
  await import("./register.js");
}

async function startRecordingGateway(): Promise<{
  origin: string;
  requests: Array<{ url: string; authorization: string | undefined }>;
}> {
  const requests: Array<{ url: string; authorization: string | undefined }> = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url ?? "", authorization: request.headers.authorization });
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        }),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

test("leaves the global provider untouched when no gateway url is injected", async () => {
  await importRegisterFresh();
  expect((globalThis as GlobalWithProvider).AI_SDK_DEFAULT_PROVIDER).toBeUndefined();
});

test("installs a default provider that calls the injected gateway with the injected token", async () => {
  const gateway = await startRecordingGateway();
  vi.stubEnv("EVELAND_MODEL_GATEWAY_URL", gateway.origin);
  vi.stubEnv("AI_GATEWAY_API_KEY", "runtime-token-1");
  await importRegisterFresh();

  const provider = (globalThis as GlobalWithProvider).AI_SDK_DEFAULT_PROVIDER as {
    languageModel: (id: string) => {
      doGenerate: (options: unknown) => Promise<unknown>;
    };
  };
  expect(provider).toBeDefined();

  await provider.languageModel("zai/glm-5.3-flash").doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  });

  expect(gateway.requests).toHaveLength(1);
  expect(gateway.requests[0]!.url).toBe("/v4/ai/language-model");
  expect(gateway.requests[0]!.authorization).toBe("Bearer runtime-token-1");
});
