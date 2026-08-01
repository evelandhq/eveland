import type { EvelandBuildInfo } from "@eveland/core/build-info";
import type { ConfigurationSnapshot } from "@eveland/core/config-diagnostics";
import type { DeploymentRecord, ResolvedAgentRoute } from "@eveland/core/contracts";
import type { EveVersionInfo } from "@eveland/core/source";
import type { GatewaySessionBindingRepository } from "./gateway-session-lifecycle.js";

export type GatewayRepository = GatewaySessionBindingRepository & {
  findRouteByHostname(hostname: string): Promise<ResolvedAgentRoute | null>;
  findProjectRoute(projectId: string): Promise<ResolvedAgentRoute | null>;
  getDeployment(deploymentId: string): Promise<DeploymentRecord | null>;
  getDeploymentEveVersion(deploymentId: string): Promise<EveVersionInfo | null>;
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
  /** Bounds the hostname route cache so unknown-subdomain traffic cannot grow it without limit. */
  routeCacheMaxEntries?: number;
  /** Socket idle timeout for public upstream proxying; streaming resets it. */
  upstreamTimeoutMs?: number;
  maxRequestBodyBytes?: number;
  affinityCookieSecure?: boolean;
  activationClient?: GatewayActivationClient;
  activationRenewIntervalMs?: number;
  playgroundSessionIdleTtlMs?: number;
  apiSessionIdleTtlMs?: number;
  now?: () => Date;
};
