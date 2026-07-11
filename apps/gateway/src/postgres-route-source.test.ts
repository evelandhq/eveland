import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";
import { createGatewayServer } from "./app.js";
import type { GatewayConfig } from "./config.js";
import {
  createPostgresRouteSource,
  parseRouteNotificationPayload,
  subscribeRouteInvalidations,
  type RouteNotificationListener,
} from "./postgres-route-source.js";

describe("route notification seam", () => {
  test("clears on listener connect and invalid or empty payloads", async () => {
    const invalidated: Array<string | null> = [];
    let onPayload: ((payload: string) => void) | undefined;
    let onListen: (() => void) | undefined;
    const listener: RouteNotificationListener = {
      async listen(_channel, payloadHandler, listenHandler) {
        onPayload = payloadHandler;
        onListen = listenHandler;
        return { state: "listening", unlisten: async () => {} };
      },
    } as RouteNotificationListener;

    await subscribeRouteInvalidations(listener, { onInvalidate: (slug) => invalidated.push(slug) });
    onListen?.();
    onPayload?.("demo");
    onPayload?.("bad payload");
    onPayload?.("   ");

    expect(invalidated).toEqual([null, "demo", null, null]);
    expect(parseRouteNotificationPayload("demo")).toBe("demo");
    expect(parseRouteNotificationPayload("UPPER")).toBeNull();
  });
});

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const servers: Server[] = [];
const sockets = new Set<Socket>();

afterEach(async () => {
  for (const socket of sockets) {
    socket.destroy();
  }
  sockets.clear();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describeWithDatabase("postgres route source", () => {
  test("triggers notify and evict the actual gateway route cache", async () => {
    const { createDatabase } = await import("@eveland/api/db/client");
    const { createPostgresStore } = await import("@eveland/api/db/postgres-store");
    const { ensureRouteNotifyTriggers } = await import("@eveland/api/db/notify-triggers");
    const { deployments } = await import("@eveland/api/db/schema");

    const database = createDatabase(databaseUrl!);
    await ensureRouteNotifyTriggers(database.client);
    const store = createPostgresStore(database);
    const project = await store.createProject({
      name: `Gateway IT ${Date.now()}`,
      importKind: "git",
      gitUrl: "https://example.com/x.git",
    });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "git",
      commitSha: null,
      sourcePath: "/tmp/it",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const firstUpstream = createNamedUpstream("first");
    const secondUpstream = createNamedUpstream("second");
    const thirdUpstream = createNamedUpstream("third");
    const firstPort = await listen(firstUpstream);
    const secondPort = await listen(secondUpstream);
    await listen(thirdUpstream, "::1", secondPort);
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "it:1",
      containerName: `eveland-it-${project.id}`,
      internalPort: 3000,
      hostPort: firstPort,
      hostAddress: "127.0.0.1",
      runtimeKind: "docker",
    });

    const routeSource = createPostgresRouteSource({
      ...makeConfig(),
      databaseUrl: databaseUrl!,
      routeTtlMs: 60_000,
      upstreamTimeoutMs: 100,
    });
    const gatewayPort = await listen(createGatewayServer({ config: { ...makeConfig(), routeTtlMs: 60_000, upstreamTimeoutMs: 100 }, routeSource }));

    try {
      await expect(fetchAgent(gatewayPort, project.slug)).resolves.toBe("first");

      await database.db.update(deployments).set({ hostPort: secondPort }).where(eq(deployments.id, deployment.id));
      await expectEventually(() => fetchAgent(gatewayPort, project.slug), "second");

      const renamedSlug = `${project.slug}-r`;
      await store.updateProjectSlug(project.id, renamedSlug);
      await expectEventually(() => fetchStatus(gatewayPort, project.slug), 404);
      await expectEventually(() => fetchAgent(gatewayPort, renamedSlug), "second");

      await database.db.update(deployments).set({ status: "stopped" }).where(eq(deployments.id, deployment.id));
      await expectEventually(() => fetchStatus(gatewayPort, renamedSlug), 404);

      await database.db.update(deployments).set({ status: "running" }).where(eq(deployments.id, deployment.id));
      await expectEventually(() => fetchAgent(gatewayPort, renamedSlug), "second");

      await database.db.update(deployments).set({ hostAddress: "::1" }).where(eq(deployments.id, deployment.id));
      await expectEventually(() => fetchAgent(gatewayPort, renamedSlug), "third");

      await database.db.update(deployments).set({ hostAddress: "127.0.0.1" }).where(eq(deployments.id, deployment.id));
      await expectEventually(() => fetchAgent(gatewayPort, renamedSlug), "second");

      await database.db.delete(deployments).where(eq(deployments.id, deployment.id));
      await expectEventually(() => fetchStatus(gatewayPort, renamedSlug), 404);
    } finally {
      await store.deleteProject(project.id);
      await routeSource.close();
      await database.close();
    }
  }, 20_000);
});

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    port: 0,
    databaseUrl: "postgres://unused",
    agentDomain: "lvh.me",
    agentUrlEnv: { EVELAND_AGENT_DOMAIN: "lvh.me" },
    upstreamTimeoutMs: 30_000,
    routeTtlMs: 30_000,
    upstreamHostOverride: null,
    ...overrides,
  };
}

function createNamedUpstream(name: string): Server {
  return createServer((_req, res) => {
    res.end(name);
  });
}

function listen(server: Server, host = "127.0.0.1", port = 0): Promise<number> {
  servers.push(server);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve((server.address() as AddressInfo).port)));
}

async function fetchAgent(port: number, slug: string): Promise<string> {
  const response = await fetch(`http://${slug}.lvh.me:${port}/`);
  if (!response.ok) {
    throw new Error(`Expected 2xx from ${slug}, got ${response.status}`);
  }
  return response.text();
}

async function fetchStatus(port: number, slug: string): Promise<number> {
  const response = await fetch(`http://${slug}.lvh.me:${port}/`);
  return response.status;
}

async function expectEventually<T>(probe: () => Promise<T>, expected: T): Promise<void> {
  const deadline = Date.now() + 5000;
  let lastValue: T | undefined;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      lastValue = await probe();
      if (lastValue === expected) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (lastError) {
    throw lastError;
  }
  expect(lastValue).toBe(expected);
}
