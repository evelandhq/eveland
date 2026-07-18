import type { EvelandBuildInfo } from "@eveland/core/build-info";
import type { ConfigurationSnapshot } from "@eveland/core/config-diagnostics";
import type { DeploymentRecord, ResolvedAgentRoute, SessionBinding } from "@eveland/core/contracts";
import type { EveVersionInfo } from "@eveland/core/source";

export type GatewayRepository = {
  findRouteByHostname(hostname: string): Promise<ResolvedAgentRoute | null>;
  findProjectRoute(projectId: string): Promise<ResolvedAgentRoute | null>;
  getDeployment(deploymentId: string): Promise<DeploymentRecord | null>;
  getDeploymentEveVersion(deploymentId: string): Promise<EveVersionInfo | null>;
  findSessionBinding(projectId: string, eveSessionId: string): Promise<SessionBinding | null>;
  bindSession(input: Omit<SessionBinding, "id" | "createdAt" | "updatedAt">): Promise<unknown>;
};

export type GatewayActivationClient = {
  activate(
    input: { deploymentId: string; kind: "public_request" | "stream" | "turn"; ownerId: string },
    signal: AbortSignal,
  ): Promise<{ leaseId: string; endpointPort: number }>;
  renew(leaseId: string): Promise<void>;
  release(leaseId: string): Promise<void>;
};

export type GatewayAppOptions = {
  allowedBaseDomains: string[];
  affinitySecret: string;
  buildInfo?: EvelandBuildInfo;
  configurationSnapshot?: ConfigurationSnapshot;
  internalServiceToken?: string;
  routeCacheTtlMs?: number;
  maxRequestBodyBytes?: number;
  affinityCookieSecure?: boolean;
  activationClient?: GatewayActivationClient;
  activationRenewIntervalMs?: number;
};
