/**
 * The front-door path contract: how the single public origin (the Agent
 * Gateway on GATEWAY_PORT) splits platform-host traffic between the API and
 * the Dashboard. Agent traffic never reaches this table — agent hostnames
 * are routed by Host header before path routing applies.
 *
 * Two rules, two sovereignties, both forwarded verbatim:
 *
 *   /.well-known/*  → API   (protocol face: RFC 8615 pins the issuer
 *                            documents to the origin root)
 *   /api/*          → API   (product face: what the API registers under
 *                            /api IS the public browser contract)
 *   everything else → Dashboard pages
 *
 * Fail-closed by construction, not by allowlist (#73's class is structural
 * now): the machine plane is registered at root `/internal/*`, which this
 * table never forwards — and the Gateway owns that namespace itself
 * (service-token authenticated, 404 otherwise) before path routing runs.
 * The api-route-namespaces architecture test pins the API's top-level route
 * namespaces to exactly {/api, /internal, /.well-known, /health}, so no
 * route can land outside this contract.
 *
 * `apps/web/next.config.ts` keeps an inlined copy of PUBLIC_API_PREFIX
 * (next.config cannot import workspace TypeScript); `next-config.test.ts`
 * pins the two against each other.
 */

/** The public API namespace, forwarded verbatim: one path spelling across
 * the browser, the front door, the API's route table, and the docs. */
export const PUBLIC_API_PREFIX = "/api";

/** OIDC discovery and JWKS must live at the issuer origin's root. */
export const WELL_KNOWN_PREFIX = "/.well-known";

export type FrontDoorTarget = "api" | "web";

/**
 * Classifies a platform-host request path. `/internal/*` never appears here:
 * the Gateway owns that namespace itself (service-token authenticated, 404
 * otherwise) before path routing runs.
 */
export function classifyFrontDoorPath(pathname: string): {
  target: FrontDoorTarget;
  /** The path to request upstream (always the request path, verbatim). */
  upstreamPath: string;
} {
  if (pathname === WELL_KNOWN_PREFIX || pathname.startsWith(`${WELL_KNOWN_PREFIX}/`)) {
    return { target: "api", upstreamPath: pathname };
  }
  if (pathname === PUBLIC_API_PREFIX || pathname.startsWith(`${PUBLIC_API_PREFIX}/`)) {
    return { target: "api", upstreamPath: pathname };
  }
  return { target: "web", upstreamPath: pathname };
}
