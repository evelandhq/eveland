import path from "node:path";
import { API_PORT, POSTGRES_HOST_PORT, PUBLIC_ORIGIN_FALLBACK } from "@evelandhq/core/ports";
import { generateAdminPassword, generateAppSecretKey, generateHexSecret } from "./secrets.ts";

/**
 * First-boot configuration rendering: the decide-per-install set from
 * .env.example, with real generated secrets and the OS-specific derived
 * addresses. This is the only place the installer "decides" anything —
 * every tuning knob keeps its code default and never appears here.
 */

export type BootstrapInputs = {
  publicOrigin: string;
  adminEmail: string;
  adminPassword: string;
  /** Optional model keys forwarded to the built-in agent's environment at seeding time. */
  anthropicApiKey?: string;
  openaiApiKey?: string;
};

export type RenderedConfig = {
  content: string;
  values: Record<string, string>;
};

export function deriveAgentBaseDomains(publicOrigin: string): string {
  const hostname = new URL(publicOrigin).hostname;
  if (hostname === "localhost" || hostname === "127.0.0.1") return "agent.localhost";
  return `agent.${hostname}`;
}

export function renderPlatformEnv(options: {
  platform: "darwin" | "linux";
  applianceRoot: string;
  inputs: BootstrapInputs;
  random?: (size: number) => Buffer;
}): RenderedConfig {
  const { platform, applianceRoot, inputs } = options;
  const databaseUrl = `postgres://eveland:eveland@127.0.0.1:${POSTGRES_HOST_PORT}/eveland`;
  // Deployed Agents run in Docker on macOS (they reach the host through
  // host.docker.internal) and as host systemd units on Linux (loopback).
  const deploymentHost = platform === "darwin" ? "host.docker.internal" : "127.0.0.1";
  const workflowWorldUrl = `postgres://eveland:eveland@${deploymentHost}:${POSTGRES_HOST_PORT}/eveland`;
  const schedulerRedeemUrl = `http://${deploymentHost}:${API_PORT}/internal/scheduler/dispatch`;
  const gatewayServiceToken = generateHexSecret(options.random);

  const values: Record<string, string> = {
    NODE_ENV: "production",
    EVELAND_PUBLIC_ORIGIN: inputs.publicOrigin,
    EVELAND_AGENT_BASE_DOMAINS: deriveAgentBaseDomains(inputs.publicOrigin),
    DATABASE_URL: databaseUrl,
    EVELAND_WORKFLOW_WORLD_URL: workflowWorldUrl,
    ...(platform === "darwin" ? { EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL: databaseUrl } : {}),
    WORKFLOW_DISPATCHER_ACTIVATION_API_URL: `http://127.0.0.1:${API_PORT}`,
    // The API validates dispatcher activations against the gateway service
    // token (apps/api/src/app-internal-routes.ts), so this is the same
    // credential by contract, not a coincidence.
    WORKFLOW_DISPATCHER_ACTIVATION_TOKEN: gatewayServiceToken,
    APP_SECRET_KEY: generateAppSecretKey(options.random),
    BETTER_AUTH_SECRET: generateHexSecret(options.random),
    EVELAND_ADMIN_EMAIL: inputs.adminEmail,
    EVELAND_ADMIN_PASSWORD: inputs.adminPassword,
    EVELAND_DATA_DIR: path.join(applianceRoot, "data"),
    EVELAND_OTLP_SERVICE_TOKEN: generateHexSecret(options.random),
    EVELAND_GATEWAY_SERVICE_TOKEN: gatewayServiceToken,
    EVELAND_GATEWAY_AFFINITY_SECRET: generateHexSecret(options.random),
    EVELAND_SCHEDULER_RUNTIME_SECRET: generateHexSecret(options.random),
    EVELAND_SCHEDULER_DISPATCH_SECRET: generateHexSecret(options.random),
    EVELAND_SCHEDULER_REDEEM_URL: schedulerRedeemUrl,
    EVELAND_RUNTIME: platform === "darwin" ? "docker" : "systemd",
  };
  if (inputs.anthropicApiKey) values.ANTHROPIC_API_KEY = inputs.anthropicApiKey;
  if (inputs.openaiApiKey) values.OPENAI_API_KEY = inputs.openaiApiKey;

  const lines = [
    "# Rendered by eveland-ctl at first boot. This file is the installation's",
    "# single configuration source: every supervised process receives exactly",
    "# these values. Tuning knobs keep their code defaults and are documented",
    "# in docs/en/reference/environment-variables.md.",
    "",
    ...Object.entries(values).map(([key, value]) => `${key}=${value}`),
    "",
  ];
  return { content: lines.join("\n"), values };
}

export function defaultBootstrapInputs(env: NodeJS.ProcessEnv): BootstrapInputs {
  return {
    publicOrigin: PUBLIC_ORIGIN_FALLBACK,
    adminEmail: "admin@example.com",
    // An operator-provided EVELAND_ADMIN_PASSWORD in the environment wins;
    // otherwise generate. Either way the value never crosses stdout.
    adminPassword: env.EVELAND_ADMIN_PASSWORD?.trim() || generateAdminPassword(),
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || undefined,
    openaiApiKey: env.OPENAI_API_KEY?.trim() || undefined,
  };
}
