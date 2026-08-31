import type { NextConfig } from "next";

/**
 * Inlined because next.config cannot import workspace TypeScript; exported so
 * `next-config.test.ts` pins it against API_INTERNAL_URL_FALLBACK in
 * @evelandhq/core/ports, so the two cannot drift apart silently.
 */
export const inlinedApiInternalUrlFallback = "http://127.0.0.1:17301";

const apiBaseUrl = (process.env.API_URL ?? inlinedApiInternalUrlFallback).replace(/\/$/, "");

/**
 * The canonical request budget, inlined because next.config cannot import
 * workspace TypeScript: cold activation + the larger upstream idle timeout +
 * a transport margin. `next-config.test.ts` pins this against
 * `resolveCanonicalRequestBudget` in @evelandhq/core/workflow-dispatch, so the
 * two cannot drift apart silently. Next's rewrite proxy otherwise gives up at
 * ~30s and hides the API/Gateway's real result behind a blank 500.
 */
const coldStartMs = positiveOr(process.env.EVELAND_COLD_START_TIMEOUT_MS, 30_000);
const upstreamMs = Math.max(
  positiveOr(process.env.EVELAND_PLAYGROUND_TIMEOUT_MS, 120_000),
  positiveOr(process.env.EVELAND_GATEWAY_UPSTREAM_TIMEOUT_MS, 120_000),
);
const marginMs = positiveOr(process.env.EVELAND_WEB_PROXY_MARGIN_MS, 15_000);
export const proxyTimeoutMs = coldStartMs + upstreamMs + marginMs;

function positiveOr(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The API subtrees the browser is allowed to reach through the web origin.
 * The rewrite is an enumerated allowlist, not a wildcard: the API also hosts
 * machine-plane endpoints (`/internal/*`, service-credential authenticated)
 * that must never be browser-reachable — a wildcard rewrite silently punched
 * through the network boundary in the single-public-origin topology and was
 * fail-open for every future API route (#73). New API routes are therefore
 * NOT exposed on the web origin unless their subtree is added here;
 * `next-config.test.ts` scans the web sources so a browser call outside the
 * allowlist fails the build instead of failing in production.
 */
export const browserApiSubtrees = [
  "agent-auth",
  "agent-connections",
  "api/auth",
  "auth",
  "git-credentials",
  "invitations",
  "members",
  "password-reset",
  "platform",
  "profile",
  "projects",
  "source-preflights",
  "system",
] as const;

const nextConfig: NextConfig = {
  experimental: {
    proxyTimeout: proxyTimeoutMs,
  },
  async rewrites() {
    return browserApiSubtrees.map((subtree) => ({
      source: `/api/eveland/${subtree}/:path*`,
      destination: `${apiBaseUrl}/${subtree}/:path*`,
    }));
  },
};

export default nextConfig;
