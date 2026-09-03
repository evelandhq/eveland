import { isPrivateBridgeIpv4 } from "@evelandhq/core/docker-bridge";

type ApiFetch = (request: Request) => Response | Promise<Response>;

const allowedPathPrefixes = ["/internal/otel/", "/internal/observability/destinations/"];
const allowedExactPaths = new Set([
  "/health",
  "/.well-known/jwks.json",
  "/internal/scheduler/dispatch",
]);

/**
 * The API's second listener: a private Docker bridge address, for the one
 * direction a host-native API cannot serve from loopback — a bridged
 * container dialing in. On Linux nothing proxies `host.docker.internal` to
 * the host's loopback, so the managed Collector reaches the API here or not
 * at all.
 *
 * This is the same listener in development and in production; what keeps it
 * safe is not the environment but three invariants enforced here:
 *
 *   1. the address is a private IPv4 (RFC 1918) — never a wildcard, a
 *      hostname, or a routable address;
 *   2. the primary listener is a SEPARATE loopback bind, so the control plane
 *      is never served on the bridge by accident;
 *   3. `createDockerBridgeIngress` serves an explicit path allowlist and 404s
 *      everything else, so what any container on this host can reach is the
 *      runtime data path, never the platform control plane.
 */
export function resolveDockerBridgeBindHost(env: NodeJS.ProcessEnv): string | undefined {
  const host = env.EVELAND_API_DOCKER_BRIDGE_HOST?.trim();
  if (!host) return undefined;
  if (!isPrivateBridgeIpv4(host)) {
    throw new Error("EVELAND_API_DOCKER_BRIDGE_HOST must be a private Docker bridge IPv4 address.");
  }
  const primaryHost = env.EVELAND_API_BIND_HOST?.trim() ?? "127.0.0.1";
  if (!(primaryHost === "localhost" || primaryHost === "::1" || primaryHost.startsWith("127."))) {
    throw new Error(
      "EVELAND_API_DOCKER_BRIDGE_HOST requires a separate loopback EVELAND_API_BIND_HOST.",
    );
  }
  return host;
}

export function createDockerBridgeIngress(apiFetch: ApiFetch): ApiFetch {
  return (request) => {
    const pathname = new URL(request.url).pathname;
    if (
      allowedExactPaths.has(pathname) ||
      allowedPathPrefixes.some((prefix) => pathname.startsWith(prefix))
    ) {
      return apiFetch(request);
    }
    return new Response("Not Found", { status: 404 });
  };
}
