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
 * The public API namespace, forwarded verbatim — the dev-server twin of the
 * front door's `/api/*` rule. Inlined because next.config cannot import
 * workspace TypeScript; `next-config.test.ts` pins it against
 * PUBLIC_API_PREFIX in @evelandhq/core/front-door. No allowlist survives
 * here: what the API registers under `/api` IS the browser contract, and the
 * machine plane lives at root `/internal/*`, which this rewrite can never
 * reach (#73's class is structural now — the api-route-namespaces
 * architecture test pins the API's namespaces).
 */
export const inlinedPublicApiPrefix = "/api";

const nextConfig: NextConfig = {
  experimental: {
    proxyTimeout: proxyTimeoutMs,
  },
  async rewrites() {
    return [
      {
        source: `${inlinedPublicApiPrefix}/:path*`,
        destination: `${apiBaseUrl}${inlinedPublicApiPrefix}/:path*`,
      },
    ];
  },
};

export default nextConfig;
