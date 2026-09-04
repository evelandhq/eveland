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
 * The address is detected by the ctl at every start, but the unit that reads
 * it starts again at every boot with no ctl in the loop. Docker renumbering
 * its bridge (a `bip` change, a reinstall) leaves a perfectly valid private
 * IPv4 that this host no longer owns, and binding it fails asynchronously
 * with EADDRNOTAVAIL — which, unhandled, would take the API's PRIMARY
 * listener down with it. `apps/api/src/server.ts` therefore handles that
 * server's 'error' event: a degraded Observation path is the honest outcome,
 * a dead API is not. Note that the address being *bindable* is not the same
 * as `docker0` being visible in `os.networkInterfaces()`: a bridge with no
 * attached container is UP but not RUNNING, so libuv omits it while the
 * address stays perfectly local — do not gate the listener on that lookup.
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
