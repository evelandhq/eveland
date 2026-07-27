import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { decodeAgentAuthEnvelope, type AgentAuthEnvelope } from "@eveland/core/agent-auth";
import type { ResolvedAgentRoute, SessionBinding } from "@eveland/core/contracts";
import { selectWeightedTarget } from "@eveland/core/routing";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { GatewayRepository } from "./gateway-types.js";

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export async function resolveTarget(
  repository: GatewayRepository,
  route: ResolvedAgentRoute,
  binding: SessionBinding | null,
  affinityKey: string,
  allowStopped = false,
): Promise<ResolvedAgentRoute["targets"][number] | null> {
  if (binding) {
    const routed = route.targets.find(
      (target) => target.deploymentId === binding.deploymentId &&
        (target.status === "running" || target.status === "draining" || (allowStopped && target.status === "stopped")),
    );
    if (routed) return routed;
    const deployment = await repository.getDeployment(binding.deploymentId);
    if (deployment &&
      (deployment.status === "running" || deployment.status === "draining" || (allowStopped && deployment.status === "stopped"))) {
      return {
        routeId: route.id,
        deploymentId: deployment.id,
        weight: 0,
        variantName: binding.variantName,
        hostPort: deployment.hostPort,
        status: deployment.status,
      };
    }
    return null;
  }
  const eligible = route.targets.filter((target) => target.status === "running" || (allowStopped && target.status === "stopped"));
  if (eligible.length === 0) return null;
  return selectWeightedTarget(eligible, affinityKey, { id: route.id, policyRevision: route.policyRevision });
}

export function affinityKey(
  headers: Headers,
  secret: string,
): {
  key: string;
  fingerprint: string;
  source: "cookie" | "version_key" | "generated";
  cookieValue: string | null;
} {
  const cookie = headers.get("cookie")?.match(/(?:^|;\s*)eveland_affinity=([^;]+)/)?.[1];
  const decodedCookie = cookie ? safeDecodeURIComponent(cookie) : null;
  const verifiedCookie = decodedCookie ? verifyAffinityCookie(decodedCookie, secret) : null;
  if (verifiedCookie) return affinityResult(verifiedCookie, "cookie", null);

  const versionKey = headers.get("x-eveland-version-key")?.trim();
  if (versionKey) return affinityResult(versionKey, "version_key", null);

  const key = randomBytes(32).toString("base64url");
  return affinityResult(key, "generated", signAffinityCookie(key, secret));
}

export function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function affinityResult(
  key: string,
  source: "cookie" | "version_key" | "generated",
  cookieValue: string | null,
) {
  return { key, source, cookieValue, fingerprint: `sha256-${createHash("sha256").update(key).digest("hex")}` };
}

export function routeExperimentId(route: ResolvedAgentRoute): string | null {
  return route.targets.length > 1 ? `${route.id}:r${route.policyRevision}` : null;
}

export function signAffinityCookie(key: string, secret: string): string {
  return `${key}.${createHmac("sha256", secret).update(key).digest("base64url")}`;
}

export function verifyAffinityCookie(value: string, secret: string): string | null {
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return null;
  const key = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expected = createHmac("sha256", secret).update(key).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (actual.toString("base64url") !== signature) return null;
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? key : null;
}

export function serializeAffinityCookie(value: string, domain: string, secure: boolean): string {
  return `eveland_affinity=${encodeURIComponent(value)}; Domain=${domain}; Path=/; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax`;
}

export function matchingBaseDomain(hostname: string, domains: string[]): string {
  return domains
    .map((domain) => domain.toLowerCase().replace(/^\.+|\.+$/g, ""))
    .find((domain) => hostname.endsWith(`.${domain}`))!;
}

export class RequestBodyTooLargeError extends Error {}

export class DownstreamAbortedError extends Error {
  constructor() {
    super("Downstream request aborted.");
  }
}

export function buildUpstreamHeaders(
  input: Headers,
  authority: string,
  protocol: string,
  requestId: string,
  remoteIp: string | null,
): Headers {
  const headers = new Headers();
  for (const [name, value] of input) {
    const lower = name.toLowerCase();
    if (
      lower === "host" ||
      hopByHopHeaders.has(lower) ||
      lower === "forwarded" ||
      lower.startsWith("x-forwarded-") ||
      lower.startsWith("x-eveland-")
    ) {
      continue;
    }
    if (lower === "cookie") {
      const cookie = value
        .split(";")
        .map((part) => part.trim())
        .filter((part) => !part.startsWith("eveland_affinity="))
        .join("; ");
      if (cookie) headers.append(name, cookie);
      continue;
    }
    headers.append(name, value);
  }
  const proto = protocol === "https:" ? "https" : "http";
  headers.set("host", authority);
  const forwardedFor = remoteIp ?? "unknown";
  headers.set("forwarded", `for=${quoteForwarded(forwardedFor)};proto=${proto};host=${quoteForwarded(authority)}`);
  headers.set("x-forwarded-for", forwardedFor);
  headers.set("x-forwarded-host", authority);
  headers.set("x-forwarded-proto", proto);
  headers.set("x-eveland-request-id", requestId);
  return headers;
}

export function buildInternalPlaygroundHeaders(
  input: Headers,
  authority: string,
  credentials: AgentAuthEnvelope["headers"] = [],
): Headers {
  const headers = new Headers({ host: authority });
  const accept = input.get("accept");
  const contentType = input.get("content-type");
  if (accept) headers.set("accept", accept);
  if (contentType) headers.set("content-type", contentType);
  for (const [name, value] of credentials) headers.set(name, value);
  return headers;
}

export function readAgentAuthEnvelope(value: string | undefined): AgentAuthEnvelope {
  return value
    ? decodeAgentAuthEnvelope(value)
    : { version: 1, authority: "loopback", headers: [] };
}

export function remoteAddress(context: Parameters<typeof getConnInfo>[0]): string | null {
  try {
    return getConnInfo(context).remote.address ?? null;
  } catch {
    return null;
  }
}

export function canonicalAuthority(value: string): string {
  return value.trim().toLowerCase();
}

export function hostnameFromAuthority(authority: string): string {
  if (authority.startsWith("[")) return authority.slice(1, authority.indexOf("]"));
  return authority.split(":", 1)[0] ?? "";
}

export function isAllowedHostname(hostname: string, domains: string[]): boolean {
  return domains.some((domain) => {
    const normalized = domain.toLowerCase().replace(/^\.+|\.+$/g, "");
    return hostname.endsWith(`.${normalized}`) && hostname.length > normalized.length + 1;
  });
}

export function requestHasBody(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

export function sessionIdFromPath(pathname: string): string | null {
  if (pathname === "/eve/v1/session/reset") return null;
  const match = /^\/eve\/v1\/session\/([^/]+)(?:\/|$)/.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export async function sessionIdFromJson(response: Response): Promise<string | null> {
  if (!response.headers.get("content-type")?.includes("application/json")) return null;
  const value = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const candidate = value?.sessionId ?? value?.session_id;
  return typeof candidate === "string" ? candidate : null;
}

export function quoteForwarded(value: string): string {
  return `"${value.replace(/["\\]/g, "")}"`;
}
