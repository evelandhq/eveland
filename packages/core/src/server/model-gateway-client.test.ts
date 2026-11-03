import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  deleteLiteLlmKey,
  generateLiteLlmKey,
  hashLiteLlmKey,
  listGatewayModelIds,
  liteLlmKeyExists,
  liteLlmManagementRoot,
  regenerateLiteLlmKey,
  testModelGatewayConnection,
} from "./model-gateway-client.js";

type Recorded = { method: string; url: string; headers: IncomingMessage["headers"]; body: any };

let server: Server;
let origin: string;
let requests: Recorded[];
let respond: (request: Recorded, res: ServerResponse) => void;

beforeEach(async () => {
  requests = [];
  respond = (_request, res) => reply(res, 200, {});
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const recorded = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      };
      requests.push(recorded);
      respond(recorded, res);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.close();
  await once(server, "close");
});

function reply(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const admin = "sk-admin-credential";
const projectKey = "sk-eveland-project-key-0001";

describe("liteLlmManagementRoot", () => {
  test("drops a trailing /v1 from the OpenAI-compatible base URL", () => {
    expect(liteLlmManagementRoot("https://llm.example/v1")).toBe("https://llm.example");
    expect(liteLlmManagementRoot("https://llm.example/proxy/v1/")).toBe(
      "https://llm.example/proxy",
    );
    expect(liteLlmManagementRoot("https://llm.example")).toBe("https://llm.example");
  });

  test("stays linear on a URL full of slashes", () => {
    const slashes = "/".repeat(100_000);
    expect(liteLlmManagementRoot(`https://llm.example${slashes}x`)).toBe(
      `https://llm.example${slashes}x`,
    );
    expect(liteLlmManagementRoot(`https://llm.example/root${slashes}`)).toBe(
      "https://llm.example/root",
    );
  });
});

describe("LiteLLM key management", () => {
  test("generates a key with the value, alias, and metadata Eveland chose", async () => {
    respond = (_request, res) => reply(res, 200, { key: projectKey, key_alias: "eveland-proj_1" });

    await expect(
      generateLiteLlmKey({
        baseUrl: `${origin}/v1`,
        adminKey: admin,
        key: projectKey,
        alias: "eveland-proj_1",
        metadata: { eveland_project_id: "proj_1" },
      }),
    ).resolves.toEqual({ status: "created" });

    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "/key/generate",
      headers: { authorization: `Bearer ${admin}` },
      body: {
        key: projectKey,
        key_alias: "eveland-proj_1",
        metadata: { eveland_project_id: "proj_1" },
      },
    });
  });

  test("reports an alias already taken instead of throwing", async () => {
    respond = (_request, res) =>
      reply(res, 400, {
        error: {
          message:
            "Key with alias 'eveland-proj_1' already exists. Unique key aliases across all keys are required.",
        },
      });

    await expect(
      generateLiteLlmKey({
        baseUrl: origin,
        adminKey: admin,
        key: projectKey,
        alias: "eveland-proj_1",
      }),
    ).resolves.toEqual({ status: "alias-taken" });
  });

  test("looks a key up by its hash so the raw key never rides a URL", async () => {
    respond = (_request, res) => reply(res, 200, { key: "hash", info: {} });

    await expect(
      liteLlmKeyExists({ baseUrl: origin, adminKey: admin, key: projectKey }),
    ).resolves.toBe(true);
    expect(requests[0]!.url).toBe(`/key/info?key=${hashLiteLlmKey(projectKey)}`);
    expect(requests[0]!.url).not.toContain(projectKey);
    expect(hashLiteLlmKey(projectKey)).toBe(createHash("sha256").update(projectKey).digest("hex"));
  });

  test("treats a 404 lookup as a missing key", async () => {
    respond = (_request, res) =>
      reply(res, 404, { error: { message: "Key not found in database" } });

    await expect(
      liteLlmKeyExists({ baseUrl: origin, adminKey: admin, key: projectKey }),
    ).resolves.toBe(false);
  });

  test("fails on a rejected management credential, without echoing any key", async () => {
    respond = (_request, res) => reply(res, 401, { error: { message: `bad key ${admin}` } });

    const failure = await liteLlmKeyExists({
      baseUrl: origin,
      adminKey: admin,
      key: projectKey,
    }).catch((error: Error) => error.message);
    expect(failure).toMatch(/HTTP 401/);
    expect(failure).not.toContain(admin);
    expect(failure).not.toContain(projectKey);
  });

  test("regenerates a key into the new value with a grace period for the old one", async () => {
    respond = (_request, res) => reply(res, 200, { key: "sk-new" });

    await regenerateLiteLlmKey({
      baseUrl: origin,
      adminKey: admin,
      key: projectKey,
      newKey: "sk-eveland-project-key-0002",
      gracePeriod: "1h",
    });

    expect(requests[0]).toMatchObject({
      method: "POST",
      url: `/key/${hashLiteLlmKey(projectKey)}/regenerate`,
      body: { new_key: "sk-eveland-project-key-0002", grace_period: "1h" },
    });
  });

  test("deletes a key by its hash, and treats an already-deleted key as done", async () => {
    await expect(
      deleteLiteLlmKey({ baseUrl: origin, adminKey: admin, key: projectKey }),
    ).resolves.toEqual({
      status: "deleted",
    });
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "/key/delete",
      body: { keys: [hashLiteLlmKey(projectKey)] },
    });

    respond = (_request, res) =>
      reply(res, 400, { error: { message: "Not all keys passed in were deleted. ..." } });
    await expect(
      deleteLiteLlmKey({ baseUrl: origin, adminKey: admin, key: projectKey }),
    ).resolves.toEqual({
      status: "not-found",
    });
  });
});

describe("listGatewayModelIds", () => {
  test("lists the model IDs the key can call", async () => {
    respond = (_request, res) =>
      reply(res, 200, {
        object: "list",
        data: [{ id: "anthropic/claude-sonnet-4.5" }, { id: "openai/gpt-5" }],
      });

    await expect(
      listGatewayModelIds({ baseUrl: `${origin}/v1`, apiKey: projectKey }),
    ).resolves.toEqual(["anthropic/claude-sonnet-4.5", "openai/gpt-5"]);
    expect(requests[0]).toMatchObject({
      url: "/v1/models",
      headers: { authorization: `Bearer ${projectKey}` },
    });
  });

  test("throws when the response is not a model list", async () => {
    respond = (_request, res) => reply(res, 200, { nope: true });
    await expect(listGatewayModelIds({ baseUrl: origin, apiKey: projectKey })).rejects.toThrow(
      /model list/,
    );
  });
});

describe("testModelGatewayConnection", () => {
  test("checks a LiteLLM management credential against /key/info", async () => {
    respond = (_request, res) => reply(res, 200, { key: "hash", info: {} });

    await expect(
      testModelGatewayConnection({ kind: "litellm", baseUrl: `${origin}/v1`, credential: admin }),
    ).resolves.toEqual({ ok: true });
    expect(requests[0]).toMatchObject({
      url: "/key/info",
      headers: { authorization: `Bearer ${admin}` },
    });
  });

  test("checks a shared key against the model list", async () => {
    respond = (_request, res) => reply(res, 200, { data: [{ id: "a" }, { id: "b" }] });

    await expect(
      testModelGatewayConnection({
        kind: "openai-compatible",
        baseUrl: `${origin}/v1`,
        credential: "sk-shared",
      }),
    ).resolves.toEqual({ ok: true, modelCount: 2 });
  });

  test("reports a failure without the credential in the message", async () => {
    respond = (_request, res) => reply(res, 403, { error: "sk-shared is not allowed" });

    const result = await testModelGatewayConnection({
      kind: "openrouter",
      baseUrl: `${origin}/v1`,
      credential: "sk-shared",
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("HTTP 403") });
    expect(JSON.stringify(result)).not.toContain("sk-shared");
  });

  test("does not follow redirects", async () => {
    respond = (_request, res) => {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
      res.end();
    };

    const result = await testModelGatewayConnection({
      kind: "openai-compatible",
      baseUrl: `${origin}/v1`,
      credential: "sk-shared",
    });
    expect(result).toMatchObject({ ok: false });
    expect(requests).toHaveLength(1);
  });
});
