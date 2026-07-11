import { normalizeAgentDomain, type AgentUrlEnv } from "@eveland/shared/agent-domain";

export type GatewayConfig = {
  port: number;
  databaseUrl: string;
  agentDomain: string;
  agentUrlEnv: AgentUrlEnv;
  upstreamTimeoutMs: number;
  routeTtlMs: number;
  upstreamHostOverride: string | null;
};

export function loadGatewayConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  const issues: string[] = [];
  const databaseUrl = nonBlank(env.DATABASE_URL);
  const agentDomain = normalizeAgentDomain(env.EVELAND_AGENT_DOMAIN);
  // EVELAND_GATEWAY_PORT exists because native dev shares one .env across apps
  // and the API also reads PORT — a shared file can't set the two ports apart.
  const gatewayPort = nonBlank(env.EVELAND_GATEWAY_PORT);
  const port = gatewayPort
    ? parsePort(gatewayPort, "EVELAND_GATEWAY_PORT", 8080, issues)
    : parsePort(env.PORT, "PORT", 8080, issues);
  const upstreamTimeoutMs = parsePositiveInteger(
    env.EVELAND_GATEWAY_UPSTREAM_TIMEOUT_MS,
    "EVELAND_GATEWAY_UPSTREAM_TIMEOUT_MS",
    30_000,
    issues,
  );
  const routeTtlMs = parsePositiveInteger(env.EVELAND_GATEWAY_ROUTE_TTL_MS, "EVELAND_GATEWAY_ROUTE_TTL_MS", 30_000, issues);
  const agentUrlScheme = nonBlank(env.EVELAND_AGENT_URL_SCHEME) ?? "http";
  const agentUrlPort = nonBlank(env.EVELAND_AGENT_URL_PORT);

  if (!databaseUrl) {
    issues.push("DATABASE_URL is not set. The gateway reads routing state from Postgres.");
  }
  if (!agentDomain) {
    issues.push("EVELAND_AGENT_DOMAIN is not set. Set the agent apex domain (e.g. lvh.me for dev).");
  } else if (!isValidApexDomain(agentDomain)) {
    issues.push("EVELAND_AGENT_DOMAIN must be a DNS apex domain without a scheme, port, wildcard, or invalid label.");
  }
  if (agentUrlScheme !== "http" && agentUrlScheme !== "https") {
    issues.push("EVELAND_AGENT_URL_SCHEME must be either http or https.");
  }
  if (agentUrlPort !== undefined) {
    parsePort(agentUrlPort, "EVELAND_AGENT_URL_PORT", undefined, issues);
  }

  if (issues.length > 0 || !databaseUrl || !agentDomain) {
    throw new Error(`Gateway startup failed:\n- ${issues.join("\n- ")}`);
  }

  return {
    port,
    databaseUrl,
    agentDomain,
    agentUrlEnv: {
      EVELAND_AGENT_DOMAIN: agentDomain,
      EVELAND_AGENT_URL_SCHEME: agentUrlScheme,
      EVELAND_AGENT_URL_PORT: agentUrlPort,
    },
    upstreamTimeoutMs,
    routeTtlMs,
    upstreamHostOverride: nonBlank(env.EVELAND_GATEWAY_UPSTREAM_HOST) ?? null,
  };
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parsePort(value: string | undefined, name: string, defaultValue: number | undefined, issues: string[]): number {
  const candidate = nonBlank(value);
  if (!candidate && defaultValue !== undefined) {
    return defaultValue;
  }
  if (!candidate) {
    issues.push(`${name} must be a port number between 1 and 65535.`);
    return 0;
  }
  const parsed = Number(candidate);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    issues.push(`${name} must be a finite integer port between 1 and 65535.`);
    return 0;
  }
  return parsed;
}

function parsePositiveInteger(value: string | undefined, name: string, defaultValue: number, issues: string[]): number {
  const candidate = nonBlank(value);
  if (!candidate) {
    return defaultValue;
  }
  const parsed = Number(candidate);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    issues.push(`${name} must be a finite positive integer.`);
    return defaultValue;
  }
  return parsed;
}

function isValidApexDomain(domain: string): boolean {
  if (domain.includes("://") || domain.includes(":") || domain.includes("*") || domain.length > 253) {
    return false;
  }
  const labels = domain.split(".");
  return labels.length >= 2 && labels.every(isValidDomainLabel);
}

function isValidDomainLabel(label: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
}
