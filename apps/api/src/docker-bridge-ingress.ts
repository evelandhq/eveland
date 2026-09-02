type ApiFetch = (request: Request) => Response | Promise<Response>;

const allowedPathPrefixes = ["/internal/otel/", "/internal/observability/destinations/"];
const allowedExactPaths = new Set([
  "/health",
  "/.well-known/jwks.json",
  "/internal/scheduler/dispatch",
]);

function isPrivateIpv4(host: string): boolean {
  const octets = host.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  const [first, second] = octets;
  return (
    first === 10 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

export function resolveDockerBridgeBindHost(env: NodeJS.ProcessEnv): string | undefined {
  const host = env.EVELAND_API_DOCKER_BRIDGE_HOST?.trim();
  if (!host) return undefined;
  if (!isPrivateIpv4(host)) {
    throw new Error("EVELAND_API_DOCKER_BRIDGE_HOST must be a private Docker bridge IPv4 address.");
  }
  if (env.NODE_ENV === "production") {
    throw new Error(
      "EVELAND_API_DOCKER_BRIDGE_HOST is only supported for Linux native development.",
    );
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
