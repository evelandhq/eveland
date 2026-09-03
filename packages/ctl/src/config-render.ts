import path from "node:path";
import { API_PORT, POSTGRES_HOST_PORT, PUBLIC_ORIGIN_FALLBACK } from "@evelandhq/core/ports";
import { envFileLine } from "./env-file.ts";
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
  /** The platform database. */
  databaseUrl: string;
  /** The shared workflow database every new build uses. */
  workflowWorldUrl: string;
  /** Optional model keys forwarded to the built-in agent's environment at seeding time. */
  anthropicApiKey?: string;
  openaiApiKey?: string;
};

/**
 * Defaults offered at the prompt. The database addresses are absent on the
 * form that has no database of its own to offer — see
 * databaseDefaults() below.
 */
export type BootstrapDefaults = Omit<BootstrapInputs, "databaseUrl" | "workflowWorldUrl"> & {
  databaseUrl?: string;
  workflowWorldUrl?: string;
};

export type RenderedConfig = {
  content: string;
  values: Record<string, string>;
};

/**
 * Which side of the database question an installation is on.
 *
 * `compose` supervises its own Postgres and runs every platform process in
 * the host namespace — the macOS appliance, and the ctl supervisor on Linux.
 * One loopback address is dialable by all of them, so ctl owns the answer.
 *
 * `external` is the Linux production form: its API runs on the Compose bridge
 * while the worker, the dispatcher and every Deployment run on the host, and a
 * single address is dialable from both namespaces only if the database sits
 * outside the installation. The operator names it.
 *
 * The OS alone cannot decide this — Linux is on both sides — so the caller
 * that chooses the form passes it in.
 */
export type DatabaseForm = "compose" | "external";

/**
 * The database addresses this installer can offer as a default.
 *
 * The external form has none. A guess would be worse than no default: a
 * loopback address the installer invented is unreachable from the bridge, and
 * one that happens to answer proves nothing about which cluster is behind it.
 */
export function databaseDefaults(
  platform: "darwin" | "linux",
  form: DatabaseForm,
): {
  databaseUrl?: string;
  workflowWorldUrl?: string;
} {
  if (form === "external") return {};
  // Agents run in Docker on macOS and reach the host through this name; on
  // Linux they are host units and share the platform's own view.
  const agentHost = platform === "darwin" ? "host.docker.internal" : "127.0.0.1";
  return {
    databaseUrl: `postgres://eveland:eveland@127.0.0.1:${POSTGRES_HOST_PORT}/eveland`,
    workflowWorldUrl: `postgres://eveland:eveland@${agentHost}:${POSTGRES_HOST_PORT}/eveland`,
  };
}

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
  const { databaseUrl, workflowWorldUrl } = inputs;
  // Deployed Agents run in Docker on macOS (they reach the host through
  // host.docker.internal) and as host systemd units on Linux (loopback).
  const deploymentHost = platform === "darwin" ? "host.docker.internal" : "127.0.0.1";
  const schedulerRedeemUrl = `http://${deploymentHost}:${API_PORT}/internal/scheduler/dispatch`;
  const gatewayServiceToken = generateHexSecret(options.random);

  const values: Record<string, string> = {
    NODE_ENV: "production",
    // Release identity (EVELAND_RELEASE_CHANNEL / EVELAND_REVISION) is not
    // rendered here: it is derived from the checkout and upserted at first
    // boot and on every update (release-identity.ts).
    EVELAND_PUBLIC_ORIGIN: inputs.publicOrigin,
    EVELAND_AGENT_BASE_DOMAINS: deriveAgentBaseDomains(inputs.publicOrigin),
    DATABASE_URL: databaseUrl,
    EVELAND_WORKFLOW_WORLD_URL: workflowWorldUrl,
    // On macOS the world's own address belongs to Agents, which reach the host
    // by a name the platform's host processes cannot resolve; they get the
    // loopback view instead. The Linux form has one address for both.
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
    ...Object.entries(values).map(([key, value]) => envFileLine(key, value)),
    "",
  ];
  return { content: lines.join("\n"), values };
}

export function defaultBootstrapInputs(
  env: NodeJS.ProcessEnv,
  platform: "darwin" | "linux",
  form: DatabaseForm,
): BootstrapDefaults {
  const database = databaseDefaults(platform, form);
  return {
    publicOrigin: PUBLIC_ORIGIN_FALLBACK,
    adminEmail: "admin@example.com",
    // Where this installer supervises the database itself its own address
    // wins: an address from the environment would point the platform
    // somewhere else while ctl still starts the Compose one. Where it has
    // none to supervise, an already-exported address is the answer — that is
    // how a non-interactive install (install.sh passes the environment
    // through) names its external database.
    databaseUrl: database.databaseUrl ?? nonEmpty(env.DATABASE_URL),
    workflowWorldUrl: database.workflowWorldUrl ?? nonEmpty(env.EVELAND_WORKFLOW_WORLD_URL),
    // An operator-provided EVELAND_ADMIN_PASSWORD in the environment wins;
    // otherwise generate. Either way the value never crosses stdout.
    adminPassword: env.EVELAND_ADMIN_PASSWORD?.trim() || generateAdminPassword(),
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || undefined,
    openaiApiKey: env.OPENAI_API_KEY?.trim() || undefined,
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}
