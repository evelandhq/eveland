import type { AgentRoute, ResolvedAgentRoute } from "@eveland/core/contracts";
import { createId } from "@eveland/core/ids";
import { validateRouteTargets } from "@eveland/core/routing";
import type { MemoryState } from "./memory-state.js";
import type { MemoryDomain } from "./memory-store-support.js";
import type {
  DeploymentRetention,
  DeploymentStore,
  RoutingStore,
} from "./store-domains.js";

export function createMemoryRoutingStore(
  state: MemoryState,
): MemoryDomain<
  RoutingStore & Pick<DeploymentStore, "getDeploymentRetention">
> {
  return {
    async ensureDeploymentRoutes(projectId, deploymentId, baseDomain) {
      const project = state.projects.find(
        (candidate) => candidate.id === projectId,
      );
      const deployment = state.deployments.find(
        (candidate) =>
          candidate.id === deploymentId && candidate.projectId === projectId,
      );
      if (!project || !deployment)
        throw new Error(
          "Cannot create Agent routes for an unknown project or deployment.",
        );
      const domain = normalizeBaseDomain(baseDomain);
      const stable = upsertMemoryRoute(state, {
        projectId,
        hostname: `${project.slug}.${domain}`,
        kind: "project",
      });
      const preview = upsertMemoryRoute(state, {
        projectId,
        hostname: `${deployment.deploymentKey}--${project.slug}.${domain}`,
        kind: "deployment",
        deploymentId,
      });
      const stableHasTargets = state.routeTargets.some(
        (target) => target.routeId === stable.id,
      );
      state.routeTargets = state.routeTargets.filter(
        (target) => target.routeId !== preview.id,
      );
      if (!stableHasTargets)
        state.routeTargets.push({
          routeId: stable.id,
          deploymentId,
          weight: 10_000,
          variantName: null,
        });
      state.routeTargets.push({
        routeId: preview.id,
        deploymentId,
        weight: 10_000,
        variantName: null,
      });
      return [stable, preview];
    },

    async reconcileAgentRoutes(baseDomain) {
      for (const project of state.projects) {
        if (project.deploymentId)
          await this.ensureDeploymentRoutes(
            project.id,
            project.deploymentId,
            baseDomain,
          );
      }
    },

    async findRouteByHostname(hostname) {
      const route =
        state.agentRoutes.find(
          (candidate) => candidate.hostname === hostname.toLowerCase(),
        ) ?? null;
      if (!route) return null;
      return {
        ...route,
        targets: state.routeTargets
          .filter((target) => target.routeId === route.id)
          .flatMap((target) => {
            const deployment = state.deployments.find(
              (candidate) => candidate.id === target.deploymentId,
            );
            return deployment
              ? [
                  {
                    ...target,
                    hostPort: deployment.hostPort,
                    status: deployment.status,
                  },
                ]
              : [];
          }),
      };
    },

    async findProjectRoute(projectId) {
      const route =
        state.agentRoutes.find(
          (candidate) =>
            candidate.projectId === projectId && candidate.kind === "project",
        ) ?? null;
      return route ? this.findRouteByHostname(route.hostname) : null;
    },

    async listProjectRoutes(projectId) {
      const routes = state.agentRoutes.filter(
        (candidate) => candidate.projectId === projectId,
      );
      return Promise.all(
        routes.map((route) => this.findRouteByHostname(route.hostname)),
      ).then((resolved) => resolved.filter(Boolean) as ResolvedAgentRoute[]);
    },

    async updateRouteTargets(routeId, targets) {
      validateRouteTargets(targets);
      const route = state.agentRoutes.find(
        (candidate) => candidate.id === routeId,
      );
      if (!route) throw new Error("Agent route not found.");
      if (route.kind === "deployment")
        throw new Error("Deployment preview routes are immutable.");
      for (const target of targets) {
        const deployment = state.deployments.find(
          (candidate) => candidate.id === target.deploymentId,
        );
        if (!deployment || deployment.projectId !== route.projectId)
          throw new Error(
            "Route target deployment does not belong to the project.",
          );
        if (target.weight > 0 && deployment.status !== "running")
          throw new Error("A weighted route target must be running.");
      }
      state.routeTargets = state.routeTargets.filter(
        (target) => target.routeId !== routeId,
      );
      state.routeTargets.push(
        ...targets.map((target) => ({ routeId, ...target })),
      );
      route.policyRevision += 1;
      route.updatedAt = new Date().toISOString();
      return (await this.findRouteByHostname(route.hostname))!;
    },

    async promoteDeployment(projectId, deploymentId) {
      const route = await this.findProjectRoute(projectId);
      if (!route) throw new Error("Project route not found.");
      const updated = await this.updateRouteTargets(route.id, [
        { deploymentId, weight: 10_000, variantName: null },
      ]);
      const project = state.projects.find(
        (candidate) => candidate.id === projectId,
      );
      const deployment = state.deployments.find(
        (candidate) => candidate.id === deploymentId,
      );
      if (project && deployment) {
        project.deploymentId = deployment.id;
        project.releaseId = deployment.releaseId;
        project.deploymentStatus = deployment.status;
        project.updatedAt = new Date().toISOString();
      }
      await this.setProjectSchedulerTarget(projectId, deploymentId);
      return updated;
    },

    async ensureAliasRoute(projectId, alias, baseDomain, targets) {
      validateRouteTargets(targets);
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(alias))
        throw new Error("Alias must be a DNS-safe label.");
      const project = state.projects.find(
        (candidate) => candidate.id === projectId,
      );
      if (!project) throw new Error("Project not found.");
      const hostname = `${alias}--${project.slug}.${normalizeBaseDomain(baseDomain)}`;
      const existed = state.agentRoutes.some(
        (candidate) => candidate.hostname === hostname,
      );
      const route = upsertMemoryRoute(state, {
        projectId,
        hostname,
        kind: "alias",
      });
      for (const target of targets) {
        const deployment = state.deployments.find(
          (candidate) => candidate.id === target.deploymentId,
        );
        if (
          !deployment ||
          deployment.projectId !== projectId ||
          (target.weight > 0 && deployment.status !== "running")
        ) {
          throw new Error(
            "Alias target must be a running deployment in this project.",
          );
        }
      }
      state.routeTargets = state.routeTargets.filter(
        (target) => target.routeId !== route.id,
      );
      state.routeTargets.push(
        ...targets.map((target) => ({ routeId: route.id, ...target })),
      );
      if (existed) route.policyRevision += 1;
      route.updatedAt = new Date().toISOString();
      return (await this.findRouteByHostname(hostname))!;
    },

    async getDeploymentRetention(projectId, keepRecent = 3) {
      const deployments = await this.listDeployments(projectId);
      const recent = new Set(
        deployments.slice(0, keepRecent).map((deployment) => deployment.id),
      );
      const mutableRouteIds = new Set(
        state.agentRoutes
          .filter((route) => route.kind !== "deployment")
          .map((route) => route.id),
      );
      const targeted = new Set(
        state.routeTargets
          .filter((target) => mutableRouteIds.has(target.routeId))
          .map((target) => target.deploymentId),
      );
      const active = new Set(
        state.sessionBindings
          .filter((binding) => {
            const session = state.sessions.find(
              (candidate) =>
                candidate.projectId === binding.projectId &&
                candidate.eveSessionId === binding.eveSessionId,
            );
            return (
              binding.projectId === projectId &&
              (!session || !["completed", "failed"].includes(session.status))
            );
          })
          .map((binding) => binding.deploymentId),
      );
      return deployments.map((deployment) => {
        const reasons: DeploymentRetention["reasons"] = [];
        if (targeted.has(deployment.id)) reasons.push("route_target");
        if (active.has(deployment.id)) reasons.push("active_session");
        if (recent.has(deployment.id)) reasons.push("recent_artifact");
        return { deployment, protected: reasons.length > 0, reasons };
      });
    },

    async findSessionBinding(projectId, eveSessionId) {
      return (
        state.sessionBindings.find(
          (binding) =>
            binding.projectId === projectId &&
            binding.eveSessionId === eveSessionId,
        ) ?? null
      );
    },

    async bindSession(input) {
      const now = new Date().toISOString();
      let binding = state.sessionBindings.find(
        (candidate) =>
          candidate.projectId === input.projectId &&
          candidate.eveSessionId === input.eveSessionId,
      );
      if (binding) Object.assign(binding, input, { updatedAt: now });
      else {
        binding = {
          id: createId("bind"),
          ...input,
          createdAt: now,
          updatedAt: now,
        };
        state.sessionBindings.push(binding);
      }
      const session = state.sessions.find(
        (candidate) =>
          candidate.projectId === input.projectId &&
          candidate.eveSessionId === input.eveSessionId,
      );
      if (session) {
        session.trigger = input.trigger;
        session.routeId = input.routeId;
        session.experimentId = input.experimentId;
        session.variantName = input.variantName;
        session.deploymentId = input.deploymentId;
      }
      return binding;
    },
  };
}

function normalizeBaseDomain(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
  if (!normalized || !/^[a-z0-9.-]+$/.test(normalized))
    throw new Error(`Invalid Agent base domain: ${value}`);
  return normalized;
}

function upsertMemoryRoute(
  state: MemoryState,
  input: {
    projectId: string;
    hostname: string;
    kind: AgentRoute["kind"];
    deploymentId?: string;
  },
): AgentRoute {
  const now = new Date().toISOString();
  const hostname = input.hostname.toLowerCase();
  const existing = state.agentRoutes.find((route) => {
    if (route.projectId !== input.projectId || route.kind !== input.kind)
      return false;
    if (input.kind === "project") return true;
    if (input.kind === "deployment" && input.deploymentId) {
      return state.routeTargets.some(
        (target) =>
          target.routeId === route.id &&
          target.deploymentId === input.deploymentId,
      );
    }
    return route.hostname === hostname;
  });
  if (existing) {
    existing.hostname = hostname;
    existing.enabled = true;
    existing.updatedAt = now;
    return existing;
  }
  const route: AgentRoute = {
    id: createId("route"),
    projectId: input.projectId,
    hostname,
    kind: input.kind,
    enabled: true,
    policyRevision: 1,
    createdAt: now,
    updatedAt: now,
  };
  state.agentRoutes.push(route);
  return route;
}
