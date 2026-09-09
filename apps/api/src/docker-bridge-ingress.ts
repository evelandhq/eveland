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

export type DockerBridgeServer = {
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
  close(callback?: () => void): unknown;
};

export type DockerBridgeListenerLog = {
  listening(address: string): void;
  bindFailed(input: { address: string; code: string; attempt: number; retryInMs: number }): void;
};

/** 1 s, 2 s, 4 s … capped at 30 s: a boot-order race clears in seconds, a renumbered bridge never does. */
export function dockerBridgeRetryDelayMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}

/**
 * Binds the bridge listener and keeps trying if the bind fails.
 *
 * The bind fails asynchronously, on the server's 'error' event, and the
 * common cause is not a renumbered bridge but a boot-order race: this unit is
 * ordered `After=docker.service`, yet on a host where docker is only
 * socket-activated nothing pulls docker into the boot transaction, so the API
 * starts before `docker0` exists and EADDRNOTAVAIL is the result. Giving up
 * on the first failure then meant the Collector's exports were refused until
 * someone restarted the API by hand, and the instance health page kept
 * showing the last telemetry sample from before the boot — an operator
 * reading "Worker unavailable" and "<5% memory" about a host that was fine.
 *
 * So the listener is retried with a capped backoff, indefinitely and unref'd:
 * a bridge that appears seconds later is picked up, a bridge that never
 * appears costs one log line every 30 s and nothing else. The primary
 * loopback listener is never affected either way.
 */
export function startDockerBridgeListener(input: {
  address: string;
  serve: (onListening: () => void) => DockerBridgeServer;
  log: DockerBridgeListenerLog;
  delayMs?: (attempt: number) => number;
  schedule?: (callback: () => void, ms: number) => { unref?: () => void };
}): { stop(): void } {
  const delayMs = input.delayMs ?? dockerBridgeRetryDelayMs;
  const schedule = input.schedule ?? ((callback, ms) => setTimeout(callback, ms));
  let stopped = false;
  let pending: { unref?: () => void } | undefined;
  let attempt = 0;

  const bind = () => {
    if (stopped) return;
    attempt += 1;
    let failed = false;
    const server = input.serve(() => {
      if (!failed) input.log.listening(input.address);
    });
    server.on("error", (error) => {
      failed = true;
      // The server is unusable after a failed listen; release it before the
      // next attempt so a retry never stacks handles.
      server.close();
      if (stopped) return;
      const retryInMs = delayMs(attempt);
      input.log.bindFailed({
        address: input.address,
        code: error.code ?? error.message,
        attempt,
        retryInMs,
      });
      pending = schedule(bind, retryInMs);
      pending.unref?.();
    });
  };

  bind();
  return {
    stop() {
      stopped = true;
      pending = undefined;
    },
  };
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
