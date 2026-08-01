import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encryptSecretValue } from "@eveland/core/server/secrets";
import type { DeploymentRecord, ReleaseRecord } from "@eveland/core/contracts";
import { createPgliteTestStore } from "@eveland/db/test";
import { execa } from "execa";
import { processNextJob } from "../jobs/process.js";
import { createRuntimeAdapterFromEnv } from "../runtime/select.js";

const APP_SECRET_KEY = process.env.APP_SECRET_KEY ?? "eveland-dev-secret-key-000000000";
const OPENAPI_TOKEN = "managed-openapi-secret-do-not-leak";
const MCP_TOKEN = "managed-mcp-secret-do-not-leak";
const FIXTURE_SOURCE_PATH = fileURLToPath(new URL("./fixtures/connections-e2e", import.meta.url));
const CONNECTION_MODULES = [
  "agent/connections/warehouse.ts",
  "agent/connections/knowledge.ts",
  "agent/subagents/researcher/connections/research.ts",
] as const;

type ConnectionServerCounts = {
  openapiCalls: number;
  mcpInitializes: number;
  mcpLists: number;
  mcpCalls: number;
  rejectedAuth: number;
};

type SessionEvent = { type?: string; data?: unknown };

async function main(): Promise<void> {
  const runtime = createRuntimeAdapterFromEnv();
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "eveland-connections-source-"));
  const connectionServer = await startConnectionServer(
    runtime.name === "docker" ? "0.0.0.0" : "127.0.0.1",
    sourceRoot,
  );
  const fixtureOrigin = `${runtime.name === "docker" ? "https://host.docker.internal" : "https://127.0.0.1"}:${connectionServer.port}`;
  const sourcePath = path.join(sourceRoot, "source");
  await cp(FIXTURE_SOURCE_PATH, sourcePath, { recursive: true });
  await materializeConnectionOrigin(sourcePath, fixtureOrigin);

  const { store, close } = await createPgliteTestStore();
  const project = await store.createProject({
    name: `Managed Connections E2E ${Date.now()}`,
    importKind: "zip",
    sourcePath,
  });
  for (const [key, value] of [
    ["CONNECTION_OPENAPI_TOKEN", OPENAPI_TOKEN],
    ["CONNECTION_MCP_TOKEN", MCP_TOKEN],
    // The fixture uses an ephemeral self-signed certificate. This setting is
    // scoped to the disposable test Agent and never changes platform TLS.
    ["NODE_TLS_REJECT_UNAUTHORIZED", "0"],
  ] as const) {
    await store.upsertSecret(project.id, key, JSON.stringify(encryptSecretValue(value, APP_SECRET_KEY)));
  }

  const deployments = new Map<string, DeploymentRecord>();
  const releases = new Map<string, ReleaseRecord>();
  const processOptions = { appSecretKey: APP_SECRET_KEY, runtime };
  try {
    assert.equal(await processNextJob(store, "connections-e2e", processOptions), true, "import_source job did not run");
    assert.equal((await store.getProject(project.id))?.status, "imported", "Connection fixture import failed");

    await store.enqueueJob(project.id, "build_deploy");
    assert.equal(await processNextJob(store, "connections-e2e", processOptions), true, "first build_deploy job did not run");
    const deployment1 = await requireCurrentDeployment(store, project.id, "first deploy");
    deployments.set(deployment1.id, deployment1);
    releases.set(deployment1.releaseId, await requireRelease(store, deployment1.releaseId));
    assertReleaseSummary(releases.get(deployment1.releaseId)!);

    await verifyRootConnections(deployment1.hostPort, connectionServer.counts);
    await verifySubagentConnection(deployment1.hostPort, connectionServer.counts);

    const beforeRestart = { ...connectionServer.counts };
    await store.enqueueJob(project.id, "restart_deployment");
    assert.equal(await processNextJob(store, "connections-e2e", processOptions), true, "restart_deployment job did not run");
    await verifyRootConnections(deployment1.hostPort, connectionServer.counts);
    assert.ok(connectionServer.counts.openapiCalls > beforeRestart.openapiCalls, "OpenAPI Connection was not usable after restart");
    assert.ok(connectionServer.counts.mcpCalls > beforeRestart.mcpCalls, "MCP Connection was not usable after restart");

    const knownDeploymentIds = new Set((await store.listDeployments(project.id)).map((deployment) => deployment.id));
    await store.enqueueJob(project.id, "build_deploy");
    assert.equal(await processNextJob(store, "connections-e2e", processOptions), true, "second build_deploy job did not run");
    const newDeployments = (await store.listDeployments(project.id)).filter((deployment) => !knownDeploymentIds.has(deployment.id));
    assert.equal(newDeployments.length, 1, "second build must create one concurrent preview Deployment");
    const deployment2 = newDeployments[0]!;
    deployments.set(deployment2.id, deployment2);
    releases.set(deployment2.releaseId, await requireRelease(store, deployment2.releaseId));
    assert.notEqual(deployment2.releaseId, deployment1.releaseId, "second build did not create a new immutable Release");
    assertReleaseSummary(releases.get(deployment2.releaseId)!);

    // A fresh Eve workflow world can report HTTP health before its first
    // model loop has completed initialization under a heavily loaded systemd
    // smoke host. Settle one no-tool turn before timing Connection actions.
    await runWarmupTurn(deployment2.hostPort);
    const beforeSecondRelease = { ...connectionServer.counts };
    await verifyRootConnections(deployment2.hostPort, connectionServer.counts);
    assert.ok(connectionServer.counts.openapiCalls > beforeSecondRelease.openapiCalls, "OpenAPI Connection was not usable in the new Release");
    assert.ok(connectionServer.counts.mcpCalls > beforeSecondRelease.mcpCalls, "MCP Connection was not usable in the new Release");

    assert.equal(connectionServer.counts.rejectedAuth, 0, "a Connection request used a missing or incorrect Project Secret");
    const logs = await store.listLogs(project.id);
    const persistedText = JSON.stringify({
      logs,
      summaries: await store.listReleaseSummaries(project.id),
    });
    assert.ok(!persistedText.includes(OPENAPI_TOKEN), "OpenAPI Project Secret leaked into logs or Release summaries");
    assert.ok(!persistedText.includes(MCP_TOKEN), "MCP Project Secret leaked into logs or Release summaries");

    console.log(
      `MANAGED CONNECTIONS E2E OK runtime=${runtime.name} releases=2 restart=1 openapiCalls=${connectionServer.counts.openapiCalls} mcpLists=${connectionServer.counts.mcpLists} mcpCalls=${connectionServer.counts.mcpCalls} subagent=1 secretLeaks=0`,
    );
  } catch (error) {
    const diagnostics = runtime.getProcessDiagnostics
      ? await Promise.all(
          [...deployments.values()].map(async (deployment) => ({
            deploymentId: deployment.id,
            diagnostics: await runtime.getProcessDiagnostics!(deployment.containerName).catch(() => null),
          })),
        )
      : [];
    throw new Error(
      `Managed Connections E2E failed: ${JSON.stringify({ counts: connectionServer.counts, diagnostics })}`,
      { cause: error },
    );
  } finally {
    for (const deployment of deployments.values()) {
      await runtime.stopProcess(deployment.containerName).catch(() => undefined);
    }
    if (runtime.removeRelease) {
      for (const release of releases.values()) {
        await runtime.removeRelease(release.imageTag).catch(() => undefined);
      }
    }
    await connectionServer.close();
    await close();
    await rm(sourceRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function materializeConnectionOrigin(sourcePath: string, origin: string): Promise<void> {
  for (const relativePath of CONNECTION_MODULES) {
    const filePath = path.join(sourcePath, relativePath);
    const source = await readFile(filePath, "utf8");
    assert.ok(source.includes("__EVELAND_CONNECTION_TEST_ORIGIN__"), `${relativePath} has no Connection origin placeholder`);
    await writeFile(filePath, source.replaceAll("__EVELAND_CONNECTION_TEST_ORIGIN__", origin), "utf8");
  }
}

async function requireCurrentDeployment(
  store: Awaited<ReturnType<typeof createPgliteTestStore>>["store"],
  projectId: string,
  label: string,
): Promise<DeploymentRecord> {
  const deployment = await store.getCurrentDeployment(projectId);
  if (!deployment || deployment.status !== "running") {
    throw new Error(`${label} failed: ${JSON.stringify({ deployment, logs: await store.listLogs(projectId, "runtime") })}`);
  }
  return deployment;
}

async function requireRelease(
  store: Awaited<ReturnType<typeof createPgliteTestStore>>["store"],
  releaseId: string,
): Promise<ReleaseRecord> {
  const release = await store.getRelease(releaseId);
  assert.ok(release, `Release ${releaseId} was not recorded`);
  return release;
}

function assertReleaseSummary(release: ReleaseRecord): void {
  assert.ok(release.summary, `Release ${release.id} has no Eve discovery summary`);
  assert.deepEqual(release.summary.connections, [
    "agent/connections/knowledge.ts",
    "agent/connections/warehouse.ts",
  ]);
  assert.deepEqual(release.summary.subagents, ["agent/subagents/researcher"]);
  assert.ok(
    !JSON.stringify(release.summary).includes("agent/subagents/researcher/connections/research.ts"),
    "root Release summary must not flatten a subagent-owned Connection into the root",
  );
}

async function verifyRootConnections(port: number, counts: ConnectionServerCounts): Promise<void> {
  const beforeOpenapi = counts.openapiCalls;
  await runConnectionFlow({
    port,
    message:
      'Use connection_search with connection "warehouse" and keywords "connection status", then call warehouse__getConnectionStatus.',
  });
  assert.equal(counts.openapiCalls, beforeOpenapi + 1, "root OpenAPI operation was not called exactly once");

  const beforeMcpLists = counts.mcpLists;
  const beforeMcpCalls = counts.mcpCalls;
  await runConnectionFlow({
    port,
    message:
      'Use connection_search with connection "knowledge" and keywords "connection record", then call knowledge__lookupConnectionRecord.',
  });
  assert.ok(counts.mcpLists > beforeMcpLists, "root MCP tools were not discovered");
  assert.equal(counts.mcpCalls, beforeMcpCalls + 1, "root MCP tool was not called exactly once");
}

async function verifySubagentConnection(port: number, counts: ConnectionServerCounts): Promise<void> {
  const beforeMcpLists = counts.mcpLists;
  const beforeMcpCalls = counts.mcpCalls;
  const session = await startSession(
    port,
    'delegate to a subagent: Use connection_search with connection "research" and keywords "connection record".',
  );
  assert.ok(
    session.events.some(
      (event) =>
        event.type === "subagent.called" &&
        (event.data as { name?: unknown } | undefined)?.name === "researcher",
    ),
    "root did not invoke the directory-form researcher",
  );
  assert.ok(counts.mcpLists > beforeMcpLists, "subagent-owned MCP Connection did not discover its tools");
  assert.equal(counts.mcpCalls, beforeMcpCalls + 1, "subagent-owned MCP Connection did not call its tool exactly once");
}

async function runConnectionFlow(input: {
  port: number;
  message: string;
}): Promise<void> {
  const session = await startSession(input.port, input.message);
  assert.ok(
    session.events.some((event) => event.type === "action.result"),
    `Connection tool produced no action.result: ${input.message}; events=${JSON.stringify(session.events)}`,
  );
}

async function runWarmupTurn(port: number): Promise<void> {
  const session = await startSession(port, "Return ready without using tools.");
  assert.ok(
    session.events.some((event) => event.type === "turn.completed"),
    "new Release warm-up turn did not complete",
  );
}

async function startSession(port: number, message: string): Promise<{
  sessionId: string;
  continuationToken: string;
  nextIndex: number;
  events: SessionEvent[];
}> {
  const response = await fetch(`http://127.0.0.1:${port}/eve/v1/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.text();
  assert.ok(response.ok, `session creation failed (${response.status}): ${body}`);
  const parsed = JSON.parse(body) as { sessionId?: unknown };
  const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : response.headers.get("x-eve-session-id");
  assert.ok(sessionId, `session creation returned no session id: ${body}`);
  return { sessionId, ...(await readUntilWaiting(port, sessionId, 0)) };
}

async function readUntilWaiting(
  port: number,
  sessionId: string,
  startIndex: number,
): Promise<{ continuationToken: string; nextIndex: number; events: SessionEvent[] }> {
  const response = await fetch(
    `http://127.0.0.1:${port}/eve/v1/session/${encodeURIComponent(sessionId)}/stream?startIndex=${startIndex}`,
    { signal: AbortSignal.timeout(60_000) },
  );
  assert.ok(response.ok && response.body, `session stream failed (${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: SessionEvent[] = [];
  let buffer = "";
  let continuationToken: string | null = null;
  try {
    while (continuationToken === null) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line) as SessionEvent;
        events.push(event);
        if (event.type === "turn.failed" || event.type === "session.failed") {
          throw new Error(`managed Connection turn failed: ${line}`);
        }
        if (event.type === "session.waiting") {
          const data = event.data as { continuationToken?: unknown } | undefined;
          if (typeof data?.continuationToken === "string") continuationToken = data.continuationToken;
        }
      }
    }
  } catch (error) {
    throw new Error(`session ${sessionId} stream aborted; events=${JSON.stringify(events)}`, { cause: error });
  }
  await reader.cancel().catch(() => undefined);
  assert.ok(continuationToken, `session ${sessionId} never reached session.waiting: ${JSON.stringify(events)}`);
  assert.ok(events.some((event) => event.type === "turn.completed"), `session ${sessionId} never completed its turn`);
  return { continuationToken, nextIndex: startIndex + events.length, events };
}

async function startConnectionServer(host: string, tlsRoot: string): Promise<{
  port: number;
  counts: ConnectionServerCounts;
  close: () => Promise<void>;
}> {
  const keyPath = path.join(tlsRoot, "connection-test-key.pem");
  const certificatePath = path.join(tlsRoot, "connection-test-certificate.pem");
  await execa("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certificatePath,
    "-days",
    "1",
    "-subj",
    "/CN=eveland-connections-e2e",
    "-addext",
    "subjectAltName=DNS:host.docker.internal,IP:127.0.0.1",
  ]);
  const counts: ConnectionServerCounts = {
    openapiCalls: 0,
    mcpInitializes: 0,
    mcpLists: 0,
    mcpCalls: 0,
    rejectedAuth: 0,
  };
  const server = createServer(
    {
      key: await readFile(keyPath),
      cert: await readFile(certificatePath),
    },
    (request, response) => {
      void handleConnectionRequest(request, response, counts).catch((error) => {
        response.statusCode = 500;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    counts,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function handleConnectionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  counts: ConnectionServerCounts,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://connection.test");
  if (request.method === "GET" && url.pathname === "/openapi/status") {
    if (!authorize(request, response, OPENAPI_TOKEN, counts)) return;
    counts.openapiCalls += 1;
    json(response, 200, { status: "managed-openapi-ok" });
    return;
  }
  if (!["/mcp/knowledge", "/mcp/research"].includes(url.pathname)) {
    json(response, 404, { error: "not_found" });
    return;
  }
  if (!authorize(request, response, MCP_TOKEN, counts)) return;
  if (request.method === "GET") {
    response.statusCode = 405;
    response.setHeader("allow", "POST");
    response.end();
    return;
  }
  if (request.method !== "POST") {
    json(response, 405, { error: "method_not_allowed" });
    return;
  }
  const message = JSON.parse(await readRequestBody(request)) as {
    id?: string | number;
    method?: string;
    params?: Record<string, unknown>;
  };
  if (message.method === "notifications/initialized") {
    response.statusCode = 202;
    response.end();
    return;
  }
  if (message.method === "initialize") {
    counts.mcpInitializes += 1;
    jsonRpc(response, message.id, {
      protocolVersion: typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "eveland-managed-connections-e2e", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "tools/list") {
    counts.mcpLists += 1;
    jsonRpc(response, message.id, {
      tools: [
        {
          name: "lookupConnectionRecord",
          description: "Look up a managed connection record",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
    });
    return;
  }
  if (message.method === "tools/call") {
    counts.mcpCalls += 1;
    assert.equal(message.params?.name, "lookupConnectionRecord", "unexpected MCP tool name");
    jsonRpc(response, message.id, {
      content: [{ type: "text", text: "managed-mcp-ok" }],
      isError: false,
    });
    return;
  }
  json(response, 400, { error: `unsupported_method:${message.method ?? "missing"}` });
}

function authorize(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  counts: ConnectionServerCounts,
): boolean {
  if (request.headers.authorization === `Bearer ${token}`) return true;
  counts.rejectedAuth += 1;
  json(response, 401, { error: "unauthorized" });
  return false;
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function jsonRpc(response: ServerResponse, id: string | number | undefined, result: unknown): void {
  json(response, 200, { jsonrpc: "2.0", id, result });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}
