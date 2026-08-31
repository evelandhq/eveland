import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCanonicalRequestBudget } from "@evelandhq/core/workflow-dispatch";
// Next's own rewrite matcher, so the contract below pins the framework's real
// path semantics instead of a reimplementation of them.
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { describe, expect, test } from "vitest";
import { API_INTERNAL_URL_FALLBACK } from "@evelandhq/core/ports";
import { BROWSER_API_SUBTREES } from "@evelandhq/core/front-door";
import nextConfig, {
  browserApiSubtrees,
  inlinedApiInternalUrlFallback,
  proxyTimeoutMs,
} from "../next.config.js";

// next.config cannot import workspace TypeScript, so it inlines the API
// upstream fallback and the browser subtree allowlist; this pins both copies
// to the single sources in core (the front door routes from the same list).
describe("inlined front-door constants", () => {
  test("API upstream fallback matches @evelandhq/core/ports", () => {
    expect(inlinedApiInternalUrlFallback).toBe(API_INTERNAL_URL_FALLBACK);
  });
  test("browser API subtrees match @evelandhq/core/front-door", () => {
    expect([...browserApiSubtrees]).toEqual([...BROWSER_API_SUBTREES]);
  });
});

/**
 * The executable budget ratchet: the Web rewrite proxy must cover the entire
 * canonical chain — cold activation + the larger upstream idle timeout + a
 * transport margin — not merely exceed the Gateway's 120s constant. If either
 * side's env defaults move, this pins the config to the core computation.
 */
describe("web proxy timeout budget", () => {
  test("covers the canonical cold-start + upstream + margin budget", () => {
    const budget = resolveCanonicalRequestBudget({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    expect(proxyTimeoutMs).toBeGreaterThanOrEqual(budget.totalMs);
    expect(budget.totalMs).toBeGreaterThan(budget.upstreamMs);
    expect(budget.totalMs).toBeGreaterThan(120_000 + budget.coldStartMs);
  });
});

async function resolveRewriteMatchers(): Promise<Array<(path: string) => unknown>> {
  const rewrites = await (nextConfig.rewrites as () => Promise<Array<{ source: string }>>)();
  return rewrites.map((rewrite) => getPathMatch(rewrite.source));
}

function isBrowserReachable(matchers: Array<(path: string) => unknown>, path: string): boolean {
  return matchers.some((matches) => matches(path) !== false);
}

/**
 * The browser-origin exposure contract for the API (#73): the web rewrite is
 * a fail-closed allowlist. The machine plane must never be reachable through
 * the web origin, and every API path the browser actually uses must be — so
 * an unlisted browser call fails here, not as a production 404, and a future
 * wildcard can't sneak the machine plane back in.
 */
describe("browser API rewrite allowlist", () => {
  test("machine-plane and non-browser endpoints are not browser-reachable", async () => {
    const matchers = await resolveRewriteMatchers();
    const machinePlane = [
      "/api/eveland/internal/scheduler/dispatch",
      "/api/eveland/internal/runtime/activations",
      "/api/eveland/internal/runtime/activations/lease_1/renew",
      "/api/eveland/internal/otel/v1/traces",
      "/api/eveland/internal/observability/destinations/dest_1/v1/logs",
      "/api/eveland/internal/workflow/dispatcher/heartbeat",
      "/api/eveland/internal/workflow/dispatcher/registration",
      "/api/eveland/internal/identity/open-caller-tokens",
      "/api/eveland/internal",
      "/api/eveland/health",
      "/api/eveland/.well-known/jwks.json",
    ];
    for (const path of machinePlane) {
      expect(isBrowserReachable(matchers, path), `${path} must not be rewritten`).toBe(false);
    }
  });

  test("allowlist entries are static subtrees, never patterns", () => {
    for (const subtree of browserApiSubtrees) {
      expect(subtree).toMatch(/^[a-z0-9-]+(\/[a-z0-9-]+)*$/);
    }
  });

  test("every API path the browser code calls is allowlisted", async () => {
    const matchers = await resolveRewriteMatchers();
    const roots = [
      // The browser transport (`api-transport.ts`) prefixes these with the
      // rewrite base in the single-public-origin topology.
      { cwd: fileURLToPath(new URL(".", import.meta.url)), viaTransport: true },
      // Cross-package producer of browser-facing `/api/eveland/...` URLs
      // (agent-auth interaction redirects consumed by `playground-route-auth`).
      {
        cwd: fileURLToPath(new URL("../../../packages/agent-auth/src", import.meta.url)),
        viaTransport: false,
      },
    ];
    const transportCall = /(?:clientRequest|apiRequest|apiFetch)(?:<[^>]*>)?\(\s*[`"'](\/[^`"']+)/g;
    const rewriteLiteral = /[`"'](\/api\/eveland\/[a-z][^`"']*)/g;

    const uncovered: string[] = [];
    for (const root of roots) {
      for (const file of globSync("**/*.{ts,tsx}", { cwd: root.cwd })) {
        // This file's own negative examples are not browser calls.
        if (file === "next-config.test.ts") continue;
        const source = readFileSync(resolve(root.cwd, file), "utf8");
        const calls: string[] = [];
        if (root.viaTransport) {
          for (const match of source.matchAll(transportCall)) {
            calls.push(`/api/eveland${match[1] ?? ""}`);
          }
        }
        for (const match of source.matchAll(rewriteLiteral)) calls.push(match[1] ?? "");
        for (const call of calls) {
          // Template interpolations stand in for one opaque path segment.
          const path = call.replace(/\$\{[^}]*\}/g, "X").replace(/[?#].*$/, "");
          if (!isBrowserReachable(matchers, path)) uncovered.push(`${file}: ${call}`);
        }
      }
    }
    expect(uncovered).toEqual([]);
  });
});
