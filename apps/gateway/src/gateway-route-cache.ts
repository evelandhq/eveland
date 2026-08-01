import type { ResolvedAgentRoute } from "@eveland/core/contracts";

export type GatewayRouteCache = {
  /** Fresh cached value (which may be a negative `null` hit), or `undefined` on miss/expiry. */
  read(hostname: string): ResolvedAgentRoute | null | undefined;
  store(hostname: string, route: ResolvedAgentRoute | null): void;
  delete(hostname: string): void;
  clear(): void;
};

// Every hostname under an allowed base domain is cacheable, including ones
// that resolve to no route, so an unbounded Map grows for as long as someone
// sends requests with fresh subdomains. Expired entries are dropped first;
// insertion order then evicts the oldest.
export function createGatewayRouteCache(input: {
  ttlMs: number;
  maxEntries: number;
}): GatewayRouteCache {
  const entries = new Map<
    string,
    { route: ResolvedAgentRoute | null; expiresAt: number }
  >();
  return {
    read(hostname) {
      const entry = entries.get(hostname);
      if (!entry || entry.expiresAt <= Date.now()) return undefined;
      return entry.route;
    },
    store(hostname, route) {
      if (entries.size >= input.maxEntries) {
        const evictedAt = Date.now();
        for (const [key, entry] of entries) {
          if (entry.expiresAt <= evictedAt) entries.delete(key);
        }
        while (entries.size >= input.maxEntries) {
          const oldest = entries.keys().next();
          if (oldest.done) break;
          entries.delete(oldest.value);
        }
      }
      entries.set(hostname, { route, expiresAt: Date.now() + input.ttlMs });
    },
    delete(hostname) {
      entries.delete(hostname);
    },
    clear() {
      entries.clear();
    },
  };
}
