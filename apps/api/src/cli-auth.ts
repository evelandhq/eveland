import { DEVICE_CODE_GRANT_TYPE } from "@better-auth/oauth-provider";

/**
 * The eveland CLI's OAuth client registration. Seeded at bootstrap as a public
 * client (RFC 8628 device flow only, no secret); dynamic client registration
 * stays disabled, so this row is the entire client surface of the provider.
 * The seed is re-applied on every boot — the config, not the database, is the
 * source of truth for this first-party client.
 */
export const EVELAND_CLI_CLIENT_ID = "eveland-cli";

/**
 * The CLI token scope model. Deliberately not full account power: a token on
 * disk in ~/.config/eveland must not be able to do team administration or
 * reach the operator surface, whatever the owning user's role is.
 *
 * - `deploy`: deliver an agent to the platform — create projects, sync and
 *   build source, promote Deployments, and manage project env (secrets).
 * - `observe`: read the delivery surface — projects, endpoints,
 *   deployments, jobs, logs, schedules, usage, and sessions (the list and a
 *   single session's transcript, nodes, and usage). Each readable path is
 *   listed below; anything else, including a project route added later, is
 *   denied until it is listed. Never secrets, source, gateway or agent-auth
 *   configuration, or the interactive Playground plane.
 */
export const CLI_TOKEN_SCOPES = ["deploy", "observe"] as const;

export type CliTokenScope = (typeof CLI_TOKEN_SCOPES)[number];

export const CLI_OAUTH_CLIENT_SEED = {
  clientId: EVELAND_CLI_CLIENT_ID,
  name: "eveland CLI",
  tokenEndpointAuthMethod: "none",
  grantTypes: [DEVICE_CODE_GRANT_TYPE],
  responseTypes: [] as string[],
  redirectUris: [] as string[],
  scopes: [...CLI_TOKEN_SCOPES] as string[],
  skipConsent: false,
  disabled: false,
};

const PROJECT_SEGMENT = "[A-Za-z0-9_-]+";

// The project sub-resources an observe token reads, one path segment each
// (`schedule-runs`, not `schedule-runs/acknowledge`).
const OBSERVE_PROJECT_READS = [
  "endpoints",
  "deployments",
  "jobs",
  "logs",
  "usage",
  "eve-version",
  "schedules",
  "schedule-attention",
  "schedule-runs",
  "sessions",
];

type ScopeRule = {
  scope: CliTokenScope | "any";
  methods: readonly string[];
  pattern: RegExp;
};

// The token-authenticated surface, deny-by-default: every rule names exact
// paths, never a prefix, so a new route stays out of reach of CLI tokens
// until a rule here lists it.
const SCOPE_RULES: readonly ScopeRule[] = [
  // Identity read for `eveland whoami` — any valid CLI token.
  { scope: "any", methods: ["GET"], pattern: /^\/api\/members\/me$/ },
  // Instance policy (the eve window) for the deploy preflight.
  { scope: "any", methods: ["GET"], pattern: /^\/api\/instance$/ },

  // Read the delivery surface.
  {
    scope: "observe",
    methods: ["GET", "HEAD"],
    pattern: new RegExp(
      `^/api/projects(?:/name-availability|/${PROJECT_SEGMENT}(?:/(?:${OBSERVE_PROJECT_READS.join("|")}))?)?$`,
    ),
  },
  // One session, read by id: its transcript, nodes, and usage.
  {
    scope: "observe",
    methods: ["GET", "HEAD"],
    pattern: new RegExp(`^/api/sessions/${PROJECT_SEGMENT}(?:/(?:events|nodes|usage))?$`),
  },

  // Deliver an agent: create project, sync source, build+deploy, promote,
  // restart, and manage project env (the API's platform-owned-key write guard
  // still applies underneath).
  { scope: "deploy", methods: ["POST"], pattern: /^\/api\/projects$/ },
  { scope: "deploy", methods: ["POST"], pattern: /^\/api\/source-preflights$/ },
  // Polling the preflight it just created — the Dashboard's own create flow.
  { scope: "deploy", methods: ["GET"], pattern: /^\/api\/source-preflights\/[A-Za-z0-9_-]+$/ },
  {
    scope: "deploy",
    methods: ["POST"],
    pattern: new RegExp(`^/api/projects/${PROJECT_SEGMENT}/(?:sync-source|build-deploy|restart)$`),
  },
  {
    scope: "deploy",
    methods: ["POST"],
    pattern: new RegExp(
      `^/api/projects/${PROJECT_SEGMENT}/deployments/${PROJECT_SEGMENT}/promote$`,
    ),
  },
  {
    scope: "deploy",
    methods: ["GET", "POST", "PUT", "DELETE"],
    pattern: new RegExp(`^/api/projects/${PROJECT_SEGMENT}/secrets(?:$|/.+)`),
  },
];

/**
 * Whether a CLI token carrying `scopes` may perform `method` on `path`.
 * Unknown scopes grant nothing; an empty scope list can still reach the
 * identity read.
 */
export function isRequestAllowedForScopes(
  method: string,
  path: string,
  scopes: readonly string[],
): boolean {
  const normalizedMethod = method.toUpperCase();
  return SCOPE_RULES.some(
    (rule) =>
      (rule.scope === "any" || scopes.includes(rule.scope)) &&
      rule.methods.includes(normalizedMethod) &&
      rule.pattern.test(path),
  );
}
