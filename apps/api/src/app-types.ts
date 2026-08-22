import type { AgentAuthProviderRegistration } from "@evelandhq/agent-auth";
import type {
  OidcAuthorizationCodeProviderOptions,
  OidcProtocol,
} from "@evelandhq/agent-auth/oidc";
import type { IdentityOidcProtocol } from "@evelandhq/identity-broker";
import type { EvelandBuildInfo } from "@evelandhq/core/build-info";
import type { SystemConfigurationDiagnostics } from "@evelandhq/core/config-diagnostics";
import type { ActivationLeaseClaim, RuntimeInstance } from "@evelandhq/core/contracts";
import type { InstanceComponentHealth } from "@evelandhq/core/instance-health";
import type { ExternalDestinationConfig } from "@evelandhq/core/observability";
import type {
  ExternalObservabilityRequestInput,
  ExternalObservabilityResponse,
} from "@evelandhq/core/server/observability";
import type { createBetterAuthRuntime } from "./auth.js";
import type { PlaygroundProxy } from "./gateway-playground.js";
import type { AuthPrincipal } from "@evelandhq/core/contracts";
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
  identityOidcProtocol?: IdentityOidcProtocol;
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
  validateObservabilityDestination?: (config: ExternalDestinationConfig) => Promise<void>;
  forwardExternalObservabilityRequest?: (
    input: ExternalObservabilityRequestInput,
  ) => Promise<ExternalObservabilityResponse>;
  runtimeActivationLeaseTtlMs?: number;
  runtimeActivationWaitTimeoutMs?: number;
  sourcePreflightTtlMs?: number;
  playgroundSessionIdleTtlMs?: number;
  /**
   * Expected `cluster:<system_identifier>/<database>` identity of the shared
   * workflow World, compared strictly against the dispatcher registration
   * before a workflow_step activation. Tests inject it; production derives it
   * from the World database itself via `EVELAND_WORKFLOW_WORLD_URL`.
   */
  worldClusterIdentity?: string;
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
