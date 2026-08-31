/**
 * Single source of truth for every fixed port the platform binds or dials by
 * default. Product code must import from here instead of repeating literals;
 * `packages/architecture-tests/src/port-literals.test.ts` enforces that.
 *
 * Placement rationale: the platform owns the contiguous block 17300-17399 for
 * fixed listeners and 18000-18999 for dynamic agent-deployment ports. Both
 * ranges sit above common development ports (3000/4000/5173/8080...), below
 * the Linux ephemeral range (32768-60999, where a listener races outbound
 * source ports), and clear of well-known squatters in between (27017 MongoDB,
 * 17500 Dropbox LanSync -- the reason the two ranges are not contiguous).
 * Generic defaults do not merely fail to start when they collide; they let a
 * process silently connect to the wrong service (#167, the Lima 5432 hijack).
 *
 * Third-party containers (Postgres, the OTel Collector) keep their
 * conventional ports inside the container/Compose network; only their host
 * port mappings move into the block. Our own services use the new ports on
 * both sides.
 */

/** Agent Gateway bind port (`GATEWAY_PORT`) — the platform's single front
 * door. Dashboard, browser API, and public agent traffic all enter here
 * (agent hosts disambiguate by Host header); the Dashboard and API listen on
 * loopback behind it, so `http://host:17300` stays "the Dashboard address"
 * across both phases of the port redesign. `EVELAND_GATEWAY_PUBLIC_PORT`
 * (the advertised port) defaults to the same value under the http scheme. */
export const GATEWAY_PORT = 17300;

/** Platform API (`PORT`), loopback-only behind the front door. */
export const API_PORT = 17301;

/** Dashboard (Next.js), loopback-only behind the front door. */
export const WEB_PORT = 17302;

/** Reserved for the Model Gateway (unmerged branch; formerly 4090). Nothing
 * on main binds it yet -- the branch remaps here on rebase. */
export const MODEL_GATEWAY_PORT = 17303;

/** Host-side mapping of the Postgres container (loopback-only publish). The
 * container network keeps `postgres:5432`. */
export const POSTGRES_HOST_PORT = 17310;

/** Host-side mappings of the managed OTel Collector's service-authenticated
 * platform receiver (gRPC/HTTP). */
export const OTEL_PLATFORM_HOST_GRPC_PORT = 17311;
export const OTEL_PLATFORM_HOST_HTTP_PORT = 17312;

/** Host-side mappings of the Collector's Agent receiver (deployment
 * credential auth; systemd Agents dial these on loopback). */
export const OTEL_AGENT_HOST_GRPC_PORT = 17313;
export const OTEL_AGENT_HOST_HTTP_PORT = 17314;

/** Documentation site dev server (dev only, never proxied). */
export const DOCS_DEV_PORT = 17350;

/** First port of the dynamic agent-deployment range (loopback only; the
 * allocator scans forward from here). Formerly 41000, which sat inside the
 * Linux ephemeral port range and collided with transient outbound sockets. */
export const DEPLOYMENT_PORT_START = 18000;

/**
 * PostgreSQL's protocol-default port: what a connection URL without an
 * explicit port means, and the port the Postgres container keeps inside the
 * Compose network. Distinct from POSTGRES_HOST_PORT on purpose.
 */
export const POSTGRES_DEFAULT_PORT = 5432;

/** Industry-standard OTLP receiver ports. The Collector container keeps them
 * internally (and external collectors conventionally use them); only our
 * host mappings move into the 173xx block. */
export const OTLP_STANDARD_GRPC_PORT = 4317;
export const OTLP_STANDARD_HTTP_PORT = 4318;

/** Collector-internal Agent receiver ports (our +10 offset from the OTLP
 * standard pair; not a standard). Docker deployments reach the Collector at
 * this port under a fixed alias on the deployment's private network. */
export const OTEL_AGENT_CONTAINER_GRPC_PORT = 4327;
export const OTEL_AGENT_CONTAINER_HTTP_PORT = 4328;

/**
 * Port an agent process listens on INSIDE its sandbox
 * (`EVELAND_INTERNAL_PORT`). This is the sandbox contract with agent repos
 * (eve apps default to 3000) in an isolated network namespace -- it cannot
 * collide with anything on the host and is deliberately NOT part of the
 * 173xx block.
 */
export const SANDBOX_INTERNAL_PORT = 3000;

// Derived default addresses. Loopback (127.0.0.1) forms are what one platform
// process uses to dial another on the same host; localhost forms are
// browser-visible origins.

/** The single browser-visible origin (`EVELAND_PUBLIC_ORIGIN`): the front
 * door. Dashboard pages, the `/api/*` public namespace (browser API, Better
 * Auth, Identity, the Agent Catalog), and `/.well-known/*` (Identity issuer
 * documents) are all served here. */
export const PUBLIC_ORIGIN_FALLBACK = `http://localhost:${GATEWAY_PORT}`;
export const WEB_ORIGIN_FALLBACK = PUBLIC_ORIGIN_FALLBACK;
export const API_ORIGIN_FALLBACK = `http://localhost:${API_PORT}`;
export const API_INTERNAL_URL_FALLBACK = `http://127.0.0.1:${API_PORT}`;
export const WEB_INTERNAL_URL_FALLBACK = `http://127.0.0.1:${WEB_PORT}`;
export const GATEWAY_INTERNAL_URL_FALLBACK = `http://127.0.0.1:${GATEWAY_PORT}`;
export const OTLP_ENDPOINT_FALLBACK = `http://127.0.0.1:${OTEL_PLATFORM_HOST_HTTP_PORT}`;
/** Agent-receiver OTLP endpoint for systemd (host-process) deployments. */
export const OTEL_AGENT_LOOPBACK_ENDPOINT = `http://127.0.0.1:${OTEL_AGENT_HOST_HTTP_PORT}`;
/** Agent-receiver OTLP endpoint for Docker deployments: the Collector joins
 * each deployment's private network under this fixed alias. */
export const OTEL_AGENT_DOCKER_ENDPOINT = `http://eveland-otel-collector:${OTEL_AGENT_CONTAINER_HTTP_PORT}`;
/** Dev JWKS URL reachable from inside Docker agent containers. */
export const IDENTITY_JWKS_URL_DOCKER_FALLBACK = `http://host.docker.internal:${API_PORT}/.well-known/jwks.json`;
export const DATABASE_URL_FALLBACK = `postgres://eveland:eveland@localhost:${POSTGRES_HOST_PORT}/eveland`;
