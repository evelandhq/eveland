import type { NextConfig } from "next";

const apiBaseUrl = (
  process.env.API_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:4000"
).replace(/\/$/, "");

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

const nextConfig: NextConfig = {
  experimental: {
    proxyTimeout: proxyTimeoutMs,
  },
  async rewrites() {
    return [
      {
        source: "/api/eveland/:path*",
        destination: `${apiBaseUrl}/:path*`,
      },
    ];
  },
};

export default nextConfig;
