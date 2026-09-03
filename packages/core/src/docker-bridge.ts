/**
 * The private Docker bridge address the API's second listener binds.
 *
 * On Linux nothing proxies `host.docker.internal` to the host's loopback, so
 * a host-native API is unreachable from a bridged container unless it also
 * binds an address on the bridge. That address must be private and it must
 * never be a wildcard: the listener it enables serves a runtime path
 * allowlist to every container on the host, and a wildcard bind would put
 * those paths on the public interface too.
 *
 * Two sides enforce the same predicate — the API refuses to bind anything
 * else (`apps/api/src/docker-bridge-ingress.ts`), and `eveland-ctl` refuses
 * to render anything else into an installation's configuration
 * (`packages/ctl/src/docker-bridge.ts`) — so it lives here rather than in
 * either of them.
 */
export function isPrivateBridgeIpv4(host: string): boolean {
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
