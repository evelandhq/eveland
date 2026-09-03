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

export function repository(routes: ResolvedAgentRoute[]): GatewayRepository & {
  bindings: Array<Record<string, unknown>>;
  operationBindings: Array<Record<string, unknown>>;
} {
  const bindings: Array<Record<string, unknown>> = [];
  const operationBindings: Array<Record<string, unknown>> = [];
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
    operationBindings,
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
            version: "0.49.0",
            expected: "0.49.x or 0.50.x",
            supportedRanges: ["0.49.x", "0.50.x"],
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
    async bindSession(input) {
      const now = new Date().toISOString();
      bindings.push({
        id: `bind_${bindings.length + 1}`,
        createdAt: now,
        updatedAt: now,
        ...input,
      });
    },
    async touchSessionBinding(projectId, eveSessionId, now = new Date()) {
      const binding = bindings.find(
        (candidate) => candidate.projectId === projectId && candidate.eveSessionId === eveSessionId,
      );
      if (!binding) return null;
      binding.updatedAt = now.toISOString();
      return binding as never;
    },
    async findOperationBinding(projectId: string, operationKey: string) {
      return (
        (operationBindings.find(
          (binding) => binding.projectId === projectId && binding.operationKey === operationKey,
        ) as never) ?? null
      );
    },
    async bindOperation(input: Record<string, unknown>) {
      const existing = operationBindings.find(
        (binding) =>
          binding.projectId === input.projectId && binding.operationKey === input.operationKey,
      );
      if (existing) return existing as never;
      const now = new Date().toISOString();
      const binding = {
        id: `opbind_${operationBindings.length + 1}`,
        createdAt: now,
        updatedAt: now,
        ...input,
      };
      operationBindings.push(binding);
      return binding as never;
    },
    async touchOperationBinding(projectId: string, operationKey: string, now = new Date()) {
      const binding = operationBindings.find(
        (candidate) => candidate.projectId === projectId && candidate.operationKey === operationKey,
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
  leaseId: string;
  responseBody: unknown;
}) {
  const upstream = await startUpstream((_request, response) => {
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify(input.responseBody));
  });
  const repo = repository([route({ hostPort: upstream.port, deploymentStatus: "stopped" })]);
  const persistenceError = new Error("session binding persistence failed");
  repo.bindSession = vi.fn(async () => {
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
