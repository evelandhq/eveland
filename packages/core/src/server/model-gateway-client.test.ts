import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ModelGatewayRequestError, listGatewayModelIds } from "./model-gateway-client.js";

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

const projectKey = "sk-project-key-0001";

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

  test("reports the gateway's status without echoing the key", async () => {
    respond = (_request, res) => reply(res, 401, { error: { message: `bad key ${projectKey}` } });

    const failure = await listGatewayModelIds({ baseUrl: origin, apiKey: projectKey }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ModelGatewayRequestError);
    expect((failure as ModelGatewayRequestError).status).toBe(401);
    expect((failure as Error).message).toMatch(/HTTP 401/);
    expect((failure as Error).message).not.toContain(projectKey);
  });

  test("does not follow redirects", async () => {
    respond = (_request, res) => {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
      res.end();
    };

    await expect(listGatewayModelIds({ baseUrl: origin, apiKey: projectKey })).rejects.toThrow(
      /HTTP 302/,
    );
    expect(requests).toHaveLength(1);
  });

  test("stays linear on a base URL full of slashes", async () => {
    respond = (_request, res) => reply(res, 200, { data: [] });
    const slashes = "/".repeat(100_000);
    await listGatewayModelIds({ baseUrl: `${origin}/v1${slashes}`, apiKey: projectKey });
    expect(requests[0]!.url).toBe("/v1/models");
  });
});
