import type { AgentAuthProviderRegistration } from "@eveland/agent-auth";
import type { OidcAuthorizationCodeProviderOptions, OidcProtocol } from "@eveland/agent-auth/oidc";
import type { EvelandBuildInfo } from "@eveland/core/build-info";
import type { SystemConfigurationDiagnostics } from "@eveland/core/config-diagnostics";
import type { ActivationLeaseClaim, RuntimeInstance } from "@eveland/core/contracts";
import type { CollectorHealth } from "@eveland/session-collector/health";
import type { InstanceComponentHealth } from "@eveland/core/instance-health";
import type { createBetterAuthRuntime } from "./auth.js";
import type { PlaygroundProxy, PlaygroundRunner } from "./gateway-playground.js";
import type { AuthPrincipal } from "@eveland/core/contracts";
import type { Hono } from "hono";

export type ApiApp = Hono<{ Variables: { principal: AuthPrincipal } }>;

export type AppOptions = {
  buildInfo?: EvelandBuildInfo;
  auth?: ReturnType<typeof createBetterAuthRuntime>;
  webOrigin?: string;
  cookieDomain?: string;
  appSecretKey?: string;
  identityIssuer?: string;
  identityAllowedOrigins?: string[];
  playgroundRunner?: PlaygroundRunner;
  playgroundProxy?: PlaygroundProxy;
  dataDir?: string;
  collectorHealth?: () => CollectorHealth;
  gatewayHealth?: () => Promise<Omit<InstanceComponentHealth, "key" | "label">>;
  configurationDiagnostics?: () => Promise<SystemConfigurationDiagnostics>;
  gatewayPublicScheme?: "http" | "https";
  gatewayPublicPort?: number | null;
  invalidateGatewayRoutes?: (hostnames: string[]) => Promise<void>;
  schedulerDispatchSecret?: string;
  schedulerRuntimeSecret?: string;
  gatewayServiceToken?: string;
  runtimeActivationLeaseTtlMs?: number;
  runtimeActivationWaitTimeoutMs?: number;
  sourcePreflightTtlMs?: number;
  playgroundSessionIdleTtlMs?: number;
  apiSessionIdleTtlMs?: number;
  sessionBindingNow?: () => Date;
  agentAuthProviders?: AgentAuthProviderRegistration[];
  oidcProtocol?: OidcProtocol;
  oidcVerifyAccessToken?: OidcAuthorizationCodeProviderOptions["verifyAccessToken"];
  oidcCallbackUrl?: string;
  agentAuthNow?: () => Date;
  runtimeActivationWaiter?: (
    claim: ActivationLeaseClaim,
    input: { signal: AbortSignal; timeoutMs: number },
  ) => Promise<RuntimeInstance>;
};
