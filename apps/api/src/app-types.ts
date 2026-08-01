import type { AgentAuthProviderRegistration } from "@eveland/agent-auth";
import type { OidcAuthorizationCodeProviderOptions, OidcProtocol } from "@eveland/agent-auth/oidc";
import type { EvelandBuildInfo } from "@eveland/core/build-info";
import type { SystemConfigurationDiagnostics } from "@eveland/core/config-diagnostics";
import type { ActivationLeaseClaim, RuntimeInstance } from "@eveland/core/contracts";
import type { InstanceComponentHealth } from "@eveland/core/instance-health";
import type {
  ExternalDestinationConfig,
} from "@eveland/core/observability";
import type {
  ExternalObservabilityRequestInput,
  ExternalObservabilityResponse,
} from "@eveland/core/server/observability";
import type { createBetterAuthRuntime } from "./auth.js";
import type { PlaygroundProxy } from "./gateway-playground.js";
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
  playgroundProxy?: PlaygroundProxy;
  dataDir?: string;
  gatewayHealth?: () => Promise<Omit<InstanceComponentHealth, "key" | "label">>;
  configurationDiagnostics?: () => Promise<SystemConfigurationDiagnostics>;
  gatewayPublicScheme?: "http" | "https";
  gatewayPublicPort?: number | null;
  invalidateGatewayRoutes?: (hostnames: string[]) => Promise<void>;
  schedulerDispatchSecret?: string;
  schedulerRuntimeSecret?: string;
  gatewayServiceToken?: string;
  otlpServiceToken?: string;
  validateObservabilityDestination?: (
    config: ExternalDestinationConfig,
  ) => Promise<void>;
  forwardExternalObservabilityRequest?: (
    input: ExternalObservabilityRequestInput,
  ) => Promise<ExternalObservabilityResponse>;
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
