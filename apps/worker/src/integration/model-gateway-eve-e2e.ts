// The Model Gateway's contract with real eve. The platform relies on eve
// behavior that no eve API promises, so this proof runs it end to end against
// an installed eve (EVE_VERSION, default: the newest verified version):
//
//   1. `eve build` trusts the model catalog the Worker seeds into
//      .eve/cache/model-catalog.json instead of fetching it;
//   2. the injected instrumentation's `setup` installs the default provider,
//      and `eve start` resolves a string model ID through it;
//   3. eve records the cost the provider writes at
//      providerMetadata.gateway.cost as usage.recorded `costUsd`;
//   4. `eve dev` honors the default provider too (vercel/eve#5787, fixed in
//      1.0.0-rc.2; skipped for older versions).
//
// Plain tsx script (no vitest), like the other integration proofs. Needs npm
// registry access for the install.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { execa, type ResultPromise } from "execa";
import { LATEST_VERIFIED_EVE_VERSION } from "@evelandhq/core/eve-compatibility";
import { MODEL_GATEWAY_ENV } from "@evelandhq/core/model-gateway";
import { loadModelCatalog, seedModelCatalog } from "../runtime/model-catalog-cache.js";
import { injectModelGateway } from "../runtime/model-gateway-injection.js";

const EVE_VERSION = process.env.EVE_VERSION ?? LATEST_VERIFIED_EVE_VERSION;
const MODEL_ID = "anthropic/claude-sonnet-4.5";
const PROJECT_KEY = "sk-eveland-e2e-project-key";
const COST_USD = 0.0123;
// eve dev bypassed the default provider before vercel/eve#5789.
const DEV_HONORS_DEFAULT_PROVIDER = !/^(0\.|1\.0\.0-rc\.[01]$)/.test(EVE_VERSION);

type Recorded = { model: unknown; authorization: string | undefined; streamOptions: unknown };
const recorded: Recorded[] = [];
const serverOptions = { reject: false, all: true, forceKillAfterDelay: 5_000 } as const;
const gateway = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}") as Record<string, unknown>;
    recorded.push({
      model: body.model,
      authorization: req.headers.authorization,
      streamOptions: body.stream_options,
    });
    const chunk = (extra: Record<string, unknown>) =>
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: body.model, ...extra })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      chunk({
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "hello from the gateway" },
            finish_reason: null,
          },
        ],
      }),
    );
    res.write(
      chunk({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, cost: COST_USD },
      }),
    );
    res.end("data: [DONE]\n\n");
  });
});
gateway.listen(0, "127.0.0.1");
await new Promise((resolve) => gateway.once("listening", resolve));
const gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`;

const root = await mkdtemp(path.join(os.tmpdir(), "eveland-model-gateway-e2e-"));
const projectDir = path.join(root, "agent-project");

try {
  await writeProject(projectDir);
  console.log(`Installing eve ${EVE_VERSION}…`);
  await execa("npm", ["install", "--no-audit", "--no-fund"], { cwd: projectDir });

  const injected = await injectModelGateway({ releaseDir: projectDir, eveVersion: EVE_VERSION });
  assert.equal(injected.status, "injected", "an eve 1.0 project gets the provider injected");

  const catalog = await loadModelCatalog({
    cacheFile: path.join(root, "cache", "model-catalog.json"),
  });
  assert.notEqual(catalog.source, "unavailable", "the AI Gateway catalog must be reachable once");
  if (catalog.source === "unavailable") throw new Error(catalog.error);
  await seedModelCatalog({
    releaseDir: projectDir,
    catalog: {
      ...catalog.catalog,
      providerAliases: { ...catalog.catalog.providerAliases, "eveland-e2e-marker": "seeded" },
    },
  });

  console.log("Building…");
  await execa(eveBin(), ["build"], { cwd: projectDir, env: noGatewayCredentials() });
  const metadata = JSON.parse(
    await readFile(
      path.join(projectDir, ".output", ".eve", "compile", "model-metadata.json"),
      "utf8",
    ),
  ) as { providerAliases?: Record<string, string> };
  assert.equal(
    metadata.providerAliases?.["eveland-e2e-marker"],
    "seeded",
    "eve build must compile the catalog Eveland seeded instead of fetching its own",
  );

  await runTurn("start", (port) =>
    execa(eveBin(), ["start"], {
      cwd: projectDir,
      env: { ...noGatewayCredentials(), ...gatewayEnv(), PORT: String(port) },
      ...serverOptions,
    }),
  );
  if (DEV_HONORS_DEFAULT_PROVIDER) {
    await runTurn("dev", (port) =>
      execa(eveBin(), ["dev", "--no-ui", "--port", String(port)], {
        cwd: projectDir,
        env: { ...noGatewayCredentials(), ...gatewayEnv() },
        ...serverOptions,
      }),
    );
  } else {
    console.log(`Skipping the eve dev check: eve ${EVE_VERSION} predates vercel/eve#5789.`);
  }
  console.log(`Model Gateway contract holds on eve ${EVE_VERSION}.`);
} finally {
  gateway.close();
  await rm(root, { recursive: true, force: true });
}

async function runTurn(mode: string, launch: (port: number) => ResultPromise): Promise<void> {
  const port = 21_000 + Math.floor(Math.random() * 2_000);
  const before = recorded.length;
  console.log(`Running one turn under eve ${mode} on port ${port}…`);
  const server = launch(port);
  try {
    await waitForHealth(port);
    const created = await fetch(`http://127.0.0.1:${port}/eve/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    const { sessionId } = (await created.json()) as { sessionId: string };
    const events = await readUntilSettled(
      `http://127.0.0.1:${port}/eve/v1/session/${sessionId}/stream`,
    );

    const calls = recorded.slice(before);
    assert.ok(calls.length > 0, `eve ${mode}: the string model must reach the Model Gateway`);
    assert.equal(calls[0]!.model, MODEL_ID, `eve ${mode}: the model ID must be forwarded verbatim`);
    assert.equal(calls[0]!.authorization, `Bearer ${PROJECT_KEY}`, `eve ${mode}: the project key`);
    assert.deepEqual(
      calls[0]!.streamOptions,
      { include_usage: true },
      `eve ${mode}: streamed usage`,
    );
    assert.match(
      events,
      /"costUsd":0\.0123/,
      `eve ${mode}: gateway cost must be recorded as costUsd`,
    );
  } catch (error) {
    server.kill("SIGTERM");
    const output = await server;
    const tail = String(output.all ?? "")
      .split("\n")
      .slice(-40)
      .join("\n");
    console.error(`eve ${mode} output (tail):\n${tail}`);
    throw error;
  } finally {
    server.kill("SIGTERM");
    await server.catch(() => undefined);
  }
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const ok = await fetch(`http://127.0.0.1:${port}/eve/v1/health`).then(
      (response) => response.ok,
      () => false,
    );
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`eve did not become healthy on port ${port}.`);
}

async function readUntilSettled(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!/"type":"turn\.(settled|failed)"/.test(text)) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => undefined);
  return text;
}

// The local binary, not npx: npx forwards no signal to the server it spawns,
// so stopping it would leave eve running and this proof hanging.
function eveBin(): string {
  return path.join(projectDir, "node_modules", ".bin", "eve");
}

function gatewayEnv(): Record<string, string> {
  return {
    [MODEL_GATEWAY_ENV.kind]: "litellm",
    [MODEL_GATEWAY_ENV.url]: gatewayUrl,
    [MODEL_GATEWAY_ENV.key]: PROJECT_KEY,
  };
}

/** Keeps eve from reaching Vercel's AI Gateway with credentials from the host. */
function noGatewayCredentials(): Record<string, string | undefined> {
  return {
    AI_GATEWAY_API_KEY: undefined,
    VERCEL_OIDC_TOKEN: undefined,
    EVE_MODEL_CONNECTION: undefined,
  };
}

async function writeProject(directory: string): Promise<void> {
  await mkdir(path.join(directory, "agent", "channels"), { recursive: true });
  await writeFile(
    path.join(directory, "package.json"),
    `${JSON.stringify({ name: "model-gateway-e2e", private: true, type: "module", dependencies: { eve: EVE_VERSION } }, null, 2)}\n`,
  );
  // A plain catalog slug and no modelContextWindowTokens: the context window
  // must come from the seeded catalog.
  await writeFile(
    path.join(directory, "agent", "agent.ts"),
    `import { defineAgent } from "eve";\n\nexport default defineAgent({ model: ${JSON.stringify(MODEL_ID)} });\n`,
  );
  await writeFile(path.join(directory, "agent", "instructions.md"), "Reply briefly.\n");
  // Local proof only: the eve channel accepts the unauthenticated test turn.
  await writeFile(
    path.join(directory, "agent", "channels", "eve.ts"),
    'import { eveChannel } from "eve/channels/eve";\nimport { none } from "eve/channels/auth";\n\nexport default eveChannel({ auth: [none()] });\n',
  );
}
