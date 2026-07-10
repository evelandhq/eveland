import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import { projectShortId } from "@eveland/shared/ids";
import { createApp } from "./app.js";
import { createMemoryStore, type Store } from "./store.js";

type UpstreamHandler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void;

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

describe("agent gateway", () => {
  test("proxies a whitelisted eve route with prefix stripped and body/query/headers intact", async () => {
    const seen: Array<{ method: string; url: string; body: string; headers: IncomingMessage["headers"] }> = [];
    const port = await startUpstream((req, res, body) => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", body: body.toString(), headers: req.headers });
      res.writeHead(202, { "content-type": "application/json", "x-eve-session-id": "sess_1" });
      res.end(JSON.stringify({ ok: true, sessionId: "sess_1" }));
    });
    const { app, shortId } = await createDeployedAgent(port);
    const rawBody = '{"message":  "hi there"}';

    const response = await app.request(`/a/${shortId}/eve/v1/session?mode=chat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-custom-signature": "sig-123" },
      body: rawBody,
    });

    expect(response.status).toBe(202);
    expect(response.headers.get("x-eve-session-id")).toBe("sess_1");
    await expect(response.json()).resolves.toEqual({ ok: true, sessionId: "sess_1" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/eve/v1/session?mode=chat", body: rawBody });
    expect(seen[0]?.headers["x-custom-signature"]).toBe("sig-123");
    expect(seen[0]?.headers["x-forwarded-prefix"]).toBe(`/a/${shortId}`);
  });

  test("streams an NDJSON response without buffering until upstream completes", async () => {
    let releaseSecondChunk = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseSecondChunk = resolve;
    });
    const port = await startUpstream(async (_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write('{"type":"first"}\n');
      await gate;
      res.end('{"type":"second"}\n');
    });
    const { app, shortId } = await createDeployedAgent(port);

    const response = await app.request(`/a/${shortId}/eve/v1/session/sess_1/stream`);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain('"first"');

    releaseSecondChunk();
    let rest = "";
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      rest += decoder.decode(chunk.value, { stream: true });
    }
    expect(rest).toContain('"second"');
  });

  test("forwards durable-workflow webhook paths", async () => {
    const seen: string[] = [];
    const port = await startUpstream((req, res) => {
      seen.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const { app, shortId } = await createDeployedAgent(port);

    const response = await app.request(`/a/${shortId}/.well-known/workflow/v1/webhook/tok-1`, { method: "POST", body: "{}" });

    expect(response.status).toBe(200);
    expect(seen).toEqual(["/.well-known/workflow/v1/webhook/tok-1"]);
  });

  test("rejects agent paths outside the public surface", async () => {
    const port = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end("must never be reached");
    });
    const { app, shortId } = await createDeployedAgent(port);

    for (const path of [`/a/${shortId}/admin`, `/a/${shortId}/eve/%2e%2e/admin`, `/a/${shortId}/`]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(404);
    }
  });

  test("returns 404 for malformed and unknown short ids", async () => {
    const app = createApp(createMemoryStore());

    for (const path of ["/a/has_underscore/eve/v1/session", "/a/zzzzzzzzzz/eve/v1/session"]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(404);
    }
  });

  test("returns 503 when the agent has no running deployment", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Undeployed", importKind: "zip" });
    const app = createApp(store);

    const response = await app.request(`/a/${projectShortId(project.id)}/eve/v1/session`, { method: "POST", body: "{}" });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "Agent has no running deployment" });
  });

  test("returns 502 when the deployment port is not reachable", async () => {
    const closedPort = await startUpstream((_req, res) => res.end());
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
    const { app, shortId } = await createDeployedAgent(closedPort);

    const response = await app.request(`/a/${shortId}/eve/v1/session`, { method: "POST", body: "{}" });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ error: "Agent deployment is unreachable" });
  });

  test("rewrites relative redirect locations back under the agent prefix", async () => {
    const port = await startUpstream((_req, res) => {
      res.writeHead(302, { location: "/eve/v1/session/sess_2/stream" });
      res.end();
    });
    const { app, shortId } = await createDeployedAgent(port);

    const response = await app.request(`/a/${shortId}/eve/v1/session`, { method: "POST", body: "{}" });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/a/${shortId}/eve/v1/session/sess_2/stream`);
  });

  test("skips the platform CORS headers that management routes get", async () => {
    const app = createApp(createMemoryStore());
    const origin = "http://localhost:3000";

    const management = await app.request("/health", { headers: { origin } });
    expect(management.headers.get("access-control-allow-origin")).toBe(origin);

    const gateway = await app.request("/a/zzzzzzzzzz/eve/v1/session", { headers: { origin } });
    expect(gateway.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("agent directory", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("lists only running agents with gateway urls derived from the request origin", async () => {
    const port = await startUpstream((_req, res) => res.end());
    const { app, store, shortId } = await createDeployedAgent(port);
    await store.createProject({ name: "Undeployed Agent", importKind: "zip" });

    const response = await app.request("http://gateway.example/.well-known/eve/agents.json");

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    await expect(response.json()).resolves.toEqual({
      agents: [{ id: shortId, name: "Gateway Agent", url: `http://gateway.example/a/${shortId}` }],
    });
  });

  test("prefers EVELAND_PUBLIC_ORIGIN for agent urls, ignoring trailing slashes", async () => {
    vi.stubEnv("EVELAND_PUBLIC_ORIGIN", "https://eve.example.com/");
    const port = await startUpstream((_req, res) => res.end());
    const { app, shortId } = await createDeployedAgent(port);

    const response = await app.request("http://gateway.example/.well-known/eve/agents.json");

    const body = (await response.json()) as { agents: Array<{ url: string }> };
    expect(body.agents[0]?.url).toBe(`https://eve.example.com/a/${shortId}`);
  });

  test("returns an empty directory when nothing is deployed", async () => {
    const app = createApp(createMemoryStore());

    const response = await app.request("/.well-known/eve/agents.json");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ agents: [] });
  });
});

async function createDeployedAgent(hostPort: number): Promise<{ app: ReturnType<typeof createApp>; store: Store; shortId: string }> {
  const store = createMemoryStore();
  const project = await store.createProject({ name: "Gateway Agent", importKind: "zip" });
  await store.recordDeployment({
    projectId: project.id,
    sourceRevisionId: "src_test",
    imageTag: "eveland/gateway:rel",
    containerName: "eveland-gateway-test",
    internalPort: 3000,
    hostPort,
    runtimeKind: "docker",
  });
  return { app: createApp(store), store, shortId: projectShortId(project.id) };
}

async function startUpstream(handler: UpstreamHandler): Promise<number> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => handler(req, res, Buffer.concat(chunks)));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}
