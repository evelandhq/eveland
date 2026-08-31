import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCanonicalRequestBudget } from "@evelandhq/core/workflow-dispatch";
// Next's own rewrite matcher, so the contract below pins the framework's real
// path semantics instead of a reimplementation of them.
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { describe, expect, test } from "vitest";
import { API_INTERNAL_URL_FALLBACK } from "@evelandhq/core/ports";
import { PUBLIC_API_PREFIX } from "@evelandhq/core/front-door";
import nextConfig, {
  inlinedApiInternalUrlFallback,
  inlinedPublicApiPrefix,
  proxyTimeoutMs,
} from "../next.config.js";

// next.config cannot import workspace TypeScript, so it inlines the API
// upstream fallback and the public API prefix; this pins both copies to the
// single sources in core (the front door routes from the same prefix).
describe("inlined front-door constants", () => {
  test("API upstream fallback matches @evelandhq/core/ports", () => {
    expect(inlinedApiInternalUrlFallback).toBe(API_INTERNAL_URL_FALLBACK);
  });
  test("public API prefix matches @evelandhq/core/front-door", () => {
    expect(inlinedPublicApiPrefix).toBe(PUBLIC_API_PREFIX);
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

/**
 * The dev rewrite is the front door's verbatim twin: exactly one rule, the
 * whole `/api` namespace, path preserved. Anything outside `/api` stays with
 * the Dashboard — the exposure contract itself lives in the API's route
 * namespaces (architecture-tests) and the front-door classifier, not here.
 */
describe("verbatim /api rewrite", () => {
  test("forwards the /api namespace verbatim and nothing else", async () => {
    const rewrites = await (
      nextConfig.rewrites as () => Promise<Array<{ source: string; destination: string }>>
    )();
    expect(rewrites).toHaveLength(1);
    const rewrite = rewrites[0]!;
    expect(rewrite.source).toBe("/api/:path*");
    expect(rewrite.destination.endsWith("/api/:path*")).toBe(true);
    const matches = getPathMatch(rewrite.source);
    expect(matches("/api/projects/proj_1")).not.toBe(false);
    expect(matches("/api/identity/login")).not.toBe(false);
    expect(matches("/apix/anything")).toBe(false);
    expect(matches("/internal/scheduler/dispatch")).toBe(false);
    expect(matches("/.well-known/jwks.json")).toBe(false);
  });
});

/**
 * The browser transport prefixes every path with PUBLIC_API_PREFIX, so a
 * call-site literal that already starts with `/api/` would double the prefix
 * and 404 — the exact bug shape the old `/api/auth/...` tunnel
 * normalized. Scan the web sources so it fails here instead.
 */
describe("transport call sites", () => {
  test("no transport path literal double-prefixes /api", () => {
    const cwd = fileURLToPath(new URL(".", import.meta.url));
    const transportCall =
      /(?:clientRequest|apiRequest|apiFetch|apiGet|apiGetOptional)(?:<[^>]*>)?\(\s*[`"'](\/api\/[^`"']*)/g;
    const offenders: string[] = [];
    for (const file of globSync("**/*.{ts,tsx}", { cwd })) {
      if (file === "next-config.test.ts") continue;
      const source = readFileSync(resolve(cwd, file), "utf8");
      for (const match of source.matchAll(transportCall)) {
        offenders.push(`${file}: ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
