import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { serve } from "@hono/node-server";
import { afterEach, vi } from "vitest";
import type { GatewayRepository, ResolvedAgentRoute } from "./app.js";

const servers: Array<ReturnType<typeof createServer>> = [];
export const gatewayServers: Array<ReturnType<typeof serve>> = [];
export const affinitySecret = "test-affinity-secret-with-enough-entropy";

export function registerGatewayTestCleanup(): void {
  afterEach(async () => {
    await Promise.all([
      ...servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
      ...gatewayServers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    ]);
  });
}

export function route(
  overrides: Partial<ResolvedAgentRoute> & {
    hostPort?: number;
    deploymentStatus?: ResolvedAgentRoute["targets"][number]["status"];
  } = {},
): ResolvedAgentRoute {
  const { hostPort = 41999, deploymentStatus = "running", ...routeOverrides } = overrides;
  return {
    id: "route_project",
    projectId: "proj_1",
    hostname: "p-alpha.agent.localhost",
    kind: "project",
    enabled: true,
    policyRevision: 1,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    targets: [
      {
        routeId: overrides.id ?? "route_project",
        deploymentId: "dep_1",
        weight: 10_000,
        variantName: null,
        hostPort,
        status: deploymentStatus,
      },
    ],
    ...routeOverrides,
  };
}

export function repository(
  routes: ResolvedAgentRoute[],
): GatewayRepository & { bindings: Array<Record<string, unknown>> } {
  const bindings: Array<Record<string, unknown>> = [];
  const deployments = new Map(
    routes
      .flatMap((route) => route.targets)
      .map(
        (target) =>
          [
            target.deploymentId,
            {
              id: target.deploymentId,
              deploymentKey: target.deploymentId
                .replace(/[^a-z0-9]/g, "")
                .padEnd(8, "0")
                .slice(0, 8),
              projectId: "proj_1",
              releaseId: `rel-${target.deploymentId}`,
              containerName: target.deploymentId,
              internalPort: 3000,
              hostPort: target.hostPort,
              status: target.status,
              runtimeKind: "docker" as const,
              createdAt: "2026-07-13T00:00:00.000Z",
              updatedAt: "2026-07-13T00:00:00.000Z",
            },
          ] as const,
      ),
  );
  return {
    bindings,
    async findRouteByHostname(hostname) {
      return routes.find((candidate) => candidate.hostname === hostname) ?? null;
    },
    async findProjectRoute(projectId) {
      return (
        routes.find(
          (candidate) => candidate.projectId === projectId && candidate.kind === "project",
        ) ?? null
      );
    },
    async getDeployment(deploymentId) {
      return deployments.get(deploymentId) ?? null;
    },
    async getDeploymentEveVersion(deploymentId) {
      return deployments.has(deploymentId)
        ? {
            version: "0.29.5",
            expected: "0.29.x, 0.30.x, or 0.31.x",
            supportedRanges: ["0.29.x", "0.30.x", "0.31.x"],
            supported: true,
            sourceRevisionId: `src-${deploymentId}`,
          }
        : null;
    },
    async findSessionBinding(projectId, eveSessionId) {
      return (
        (bindings.find(
          (binding) => binding.projectId === projectId && binding.eveSessionId === eveSessionId,
        ) as never) ?? null
      );
    },
    async findSessionBindingByContinuationToken(projectId, continuationToken) {
      return (
        (bindings.find(
          (binding) =>
            binding.projectId === projectId && binding.continuationToken === continuationToken,
        ) as never) ?? null
      );
    },
    async bindSession(input) {
      const now = new Date().toISOString();
      bindings.push({
        id: `bind_${bindings.length + 1}`,
        createdAt: now,
        updatedAt: now,
        ...input,
      });
    },
    async setSessionBindingContinuationToken(
      projectId,
      eveSessionId,
      continuationToken,
      now = new Date(),
    ) {
      const binding = bindings.find(
        (candidate) => candidate.projectId === projectId && candidate.eveSessionId === eveSessionId,
      );
      if (!binding) return null;
      binding.continuationToken = continuationToken;
      binding.updatedAt = now.toISOString();
      return binding as never;
    },
    async touchSessionBinding(projectId, eveSessionId, now = new Date()) {
      const binding = bindings.find(
        (candidate) => candidate.projectId === projectId && candidate.eveSessionId === eveSessionId,
      );
      if (!binding) return null;
      binding.updatedAt = now.toISOString();
      return binding as never;
    },
  };
}

export async function startUpstream(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ port: number }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Upstream fixture did not bind.");
  return { port: address.port };
}

export async function activatedSessionPersistenceFailureFixture(input: {
  trigger: "api" | "playground";
  eveSessionId: string;
  continuationToken: string;
  leaseId: string;
  responseBody: unknown;
}) {
  const upstream = await startUpstream((_request, response) => {
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify(input.responseBody));
  });
  const repo = repository([route({ hostPort: upstream.port, deploymentStatus: "stopped" })]);
  repo.bindings.push({
    id: `bind_persist_${input.trigger}`,
    projectId: "proj_1",
    eveSessionId: input.eveSessionId,
    continuationToken: input.continuationToken,
    routeId: "route_project",
    deploymentId: "dep_1",
    trigger: input.trigger,
    variantName: null,
    experimentId: null,
    requestId: `request_persist_${input.trigger}`,
    remoteIp: null,
    affinityFingerprint: null,
    affinitySource: null,
    createdAt: "2026-07-28T10:00:00.000Z",
    updatedAt: "2026-07-28T10:00:00.000Z",
  });
  const persistenceError = new Error("session token persistence failed");
  repo.setSessionBindingContinuationToken = vi.fn(async () => {
    throw persistenceError;
  });
  const activationClient = {
    activate: vi.fn(async () => ({
      leaseId: input.leaseId,
      endpointPort: upstream.port,
    })),
    renew: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
  };
  return { repo, activationClient, persistenceError };
}
