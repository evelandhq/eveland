import { describe, expect, test } from "vitest";
import { createRouteCache } from "./route-cache.js";
import type { AgentRoute } from "./route-source.js";

const route: AgentRoute = { slug: "demo", name: "Demo", hostAddress: "127.0.0.1", hostPort: 41000 };

describe("route cache", () => {
  test("returns entries until the TTL expires", () => {
    let clock = 0;
    const cache = createRouteCache({ ttlMs: 1000, now: () => clock });
    cache.set("demo", route);
    expect(cache.get("demo")).toEqual({ route });
    clock = 999;
    expect(cache.get("demo")).toEqual({ route });
    clock = 1000;
    expect(cache.get("demo")).toBeUndefined();
  });

  test("caches negative lookups distinctly from cache misses", () => {
    const cache = createRouteCache({ ttlMs: 1000 });
    cache.set("ghost", null);
    expect(cache.get("ghost")).toEqual({ route: null });
    expect(cache.get("never-seen")).toBeUndefined();
  });

  test("invalidate drops a single slug; clear drops everything", () => {
    const cache = createRouteCache({ ttlMs: 1000 });
    cache.set("a", route);
    cache.set("b", route);
    cache.invalidate("a");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toEqual({ route });
    cache.clear();
    expect(cache.get("b")).toBeUndefined();
  });

  test("clears wholesale when maxEntries is exceeded", () => {
    const cache = createRouteCache({ ttlMs: 1000, maxEntries: 2 });
    cache.set("a", route);
    cache.set("b", route);
    cache.set("c", route);
    expect(cache.size()).toBe(1);
    expect(cache.get("c")).toEqual({ route });
  });
});
