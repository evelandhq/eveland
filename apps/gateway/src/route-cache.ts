import type { AgentRoute } from "./route-source.js";

export type RouteCache = {
  get(slug: string): { route: AgentRoute | null } | undefined;
  set(slug: string, route: AgentRoute | null): void;
  invalidate(slug: string): void;
  clear(): void;
  size(): number;
};

export function createRouteCache(options: { ttlMs: number; maxEntries?: number; now?: () => number }): RouteCache {
  const { ttlMs, maxEntries = 10_000, now = Date.now } = options;
  const entries = new Map<string, { route: AgentRoute | null; expiresAt: number }>();

  return {
    get(slug) {
      const entry = entries.get(slug);
      if (!entry) {
        return undefined;
      }
      if (entry.expiresAt <= now()) {
        entries.delete(slug);
        return undefined;
      }
      return { route: entry.route };
    },
    set(slug, route) {
      if (entries.size >= maxEntries) {
        entries.clear();
      }
      entries.set(slug, { route, expiresAt: now() + ttlMs });
    },
    invalidate(slug) {
      entries.delete(slug);
    },
    clear() {
      entries.clear();
    },
    size() {
      return entries.size;
    },
  };
}
