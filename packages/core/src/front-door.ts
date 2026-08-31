/**
 * The front-door path contract: how the single public origin (the Agent
 * Gateway on GATEWAY_PORT) splits platform-host traffic between the API and
 * the Dashboard. Agent traffic never reaches this table — agent hostnames
 * are routed by Host header before path routing applies.
 *
 * `apps/web/next.config.ts` keeps an inlined copy of the subtree allowlist
 * (next.config cannot import workspace TypeScript); `next-config.test.ts`
 * pins the two against each other.
 */

/** Browser-facing API namespace. `<prefix>/<subtree>/*` proxies to the API's
 * `/<subtree>/*` for allowlisted subtrees only. */
export const BROWSER_API_PREFIX = "/api/eveland";

/**
 * The API subtrees the browser is allowed to reach through the public
 * origin. A fail-closed allowlist, not a wildcard: the API also hosts
 * machine-plane endpoints (`/internal/*`, service-credential authenticated)
 * that must never be browser-reachable — a wildcard proxy silently punched
 * through the network boundary and was fail-open for every future API route
 * (#73). New API routes are NOT exposed on the public origin unless their
 * subtree is added here.
 */
export const BROWSER_API_SUBTREES = [
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

/** Better Auth's own namespace, forwarded verbatim (its basePath on the API
 * is exactly this, so URLs it generates against the public origin resolve). */
export const AUTH_PATH_PREFIX = "/api/auth";

/** Eveland Identity's issuer-anchored namespace, forwarded verbatim: the SDK
 * generates `${issuer}/api/identity/login` challenges and administrators
 * register `${issuer}/api/identity/oidc/callback` at their IdP, so these
 * absolute paths must resolve against the public origin. */
export const IDENTITY_PATH_PREFIX = "/api/identity";

/** The public Agent Catalog projection (exact path, no subtree): the
 * identity-independent entry point external chat clients resolve against the
 * public origin. */
export const AGENT_CATALOG_PATH = "/api/agent-catalog";

/** OIDC discovery and JWKS must live at the issuer origin's root. */
export const WELL_KNOWN_PREFIX = "/.well-known";

export type FrontDoorTarget = "api" | "web" | "blocked";

/**
 * Classifies a platform-host request path. `/internal/*` never appears here:
 * the Gateway owns that namespace itself (service-token authenticated, 404
 * otherwise) before path routing runs.
 */
export function classifyFrontDoorPath(pathname: string): {
  target: FrontDoorTarget;
  /** The path to request upstream (BROWSER_API_PREFIX stripped for API). */
  upstreamPath: string;
} {
  if (pathname === WELL_KNOWN_PREFIX || pathname.startsWith(`${WELL_KNOWN_PREFIX}/`)) {
    return { target: "api", upstreamPath: pathname };
  }
  if (pathname === AUTH_PATH_PREFIX || pathname.startsWith(`${AUTH_PATH_PREFIX}/`)) {
    return { target: "api", upstreamPath: pathname };
  }
  if (pathname === IDENTITY_PATH_PREFIX || pathname.startsWith(`${IDENTITY_PATH_PREFIX}/`)) {
    return { target: "api", upstreamPath: pathname };
  }
  if (pathname === AGENT_CATALOG_PATH) {
    return { target: "api", upstreamPath: pathname };
  }
  if (pathname === BROWSER_API_PREFIX || pathname.startsWith(`${BROWSER_API_PREFIX}/`)) {
    const remainder = pathname.slice(BROWSER_API_PREFIX.length).replace(/^\//, "");
    const allowed = BROWSER_API_SUBTREES.some(
      (subtree) => remainder === subtree || remainder.startsWith(`${subtree}/`),
    );
    if (!allowed) return { target: "blocked", upstreamPath: pathname };
    return { target: "api", upstreamPath: `/${remainder}` };
  }
  return { target: "web", upstreamPath: pathname };
}
