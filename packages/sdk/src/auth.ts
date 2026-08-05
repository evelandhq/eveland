import { createPublicKey } from "node:crypto";
import {
  extractBearerToken,
  verifyJwtEcdsa,
  withAuthChallenges,
  type AuthFn,
} from "eve/channels/auth";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Diagnostic sink for the reasons this AuthFn declines a request. Every
 * decline is silent to the caller by design, so the log is the only way to
 * tell "Eveland Identity is misconfigured" apart from "that token was not
 * ours". Defaults to Eve's `EVE_LOG_LEVEL=debug` console output.
 */
export type EvelandIdentityLogger = (message: string, fields?: Record<string, unknown>) => void;

/** How long a successfully fetched key set is served without refetching. */
const JWKS_FRESH_MS = 60_000;
/**
 * How long a key set keeps being served after a refresh fails. Eveland rotates
 * signing keys on a 90-day schedule and keeps retiring keys published, so a
 * grace window of minutes costs nothing; without it, a brief Identity service
 * outage would silently drop every authenticated user. Sized above the longest
 * Caller Token lifetime so an outage shorter than one token cycle is invisible.
 */
const JWKS_STALE_MS = 30 * 60_000;
/** Floor between refresh attempts once one has failed. */
const JWKS_RETRY_MS = 10_000;

export type EvelandIdentityOptions = {
  issuer?: string;
  projectId?: string;
  jwksUrl?: string;
  fetch?: FetchLike;
  now?: () => Date;
  logger?: EvelandIdentityLogger;
  /**
   * Realm ids (`irlm_...`) whose users this Agent accepts. Eveland's identity
   * broker authenticates callers but does not decide which realm may reach
   * which Agent, so a token from ANY enabled realm verifies here by default.
   * Set this when the Agent is meant for specific realms; tokens from other
   * realms are then rejected as unauthenticated. Defaults to
   * EVELAND_ALLOWED_REALM_IDS (comma-separated) when unset.
   */
  allowedRealms?: readonly string[];
};

export type EvelandAuthenticationChallenge = {
  kind: "eveland";
  url: string;
  projectId: string;
  displayName: string;
};

export function evelandIdentity(options: EvelandIdentityOptions = {}): AuthFn<Request> {
  const issuer = (options.issuer ?? process.env.EVELAND_IDENTITY_ISSUER ?? "").replace(/\/$/, "");
  const projectId = options.projectId ?? process.env.EVELAND_PROJECT_ID ?? "";
  const jwksUrl =
    options.jwksUrl ??
    process.env.EVELAND_IDENTITY_JWKS_URL ??
    (issuer ? `${issuer}/.well-known/jwks.json` : "");
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const log = options.logger ?? defaultLogger;
  const allowedRealms = new Set(
    (options.allowedRealms ??
      (process.env.EVELAND_ALLOWED_REALM_IDS ?? "")
        .split(",")
        .map((realm) => realm.trim())
        .filter(Boolean)) as readonly string[],
  );
  let cache:
    | { keys: Array<Record<string, unknown>>; freshUntil: number; staleUntil: number }
    | undefined;
  let nextAttemptAt = 0;

  /**
   * Serves the key set, refreshing it when stale. A failed refresh keeps
   * serving the cached keys for JWKS_STALE_MS rather than rejecting: this
   * AuthFn fails open, so throwing here would not fail closed, it would just
   * turn a transient Identity outage into a silent identity loss for every
   * already-authenticated user. Returns an empty set only when nothing usable
   * is left, which the caller reads as "no matching key" and declines.
   */
  async function loadKeys(force = false): Promise<Array<Record<string, unknown>>> {
    const current = now().getTime();
    if (!force && cache && cache.freshUntil > current) {
      return cache.keys;
    }
    if (current < nextAttemptAt && cache && cache.staleUntil > current) {
      return cache.keys;
    }

    let response: Response;
    try {
      response = await fetcher(jwksUrl, {
        headers: { accept: "application/json" },
        redirect: "error",
      });
    } catch (error) {
      return refreshFailed(current, "Eveland Identity signing keys could not be fetched.", {
        jwksUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!response.ok) {
      return refreshFailed(current, "Eveland Identity signing keys returned an error status.", {
        jwksUrl,
        status: response.status,
      });
    }
    const body = (await response.json().catch(() => null)) as { keys?: unknown } | null;
    if (!Array.isArray(body?.keys)) {
      return refreshFailed(current, "Eveland Identity signing keys were malformed.", { jwksUrl });
    }

    const keys = body.keys.filter(isRecord);
    cache = { keys, freshUntil: current + JWKS_FRESH_MS, staleUntil: current + JWKS_STALE_MS };
    nextAttemptAt = 0;
    return keys;
  }

  function refreshFailed(
    current: number,
    reason: string,
    fields: Record<string, unknown>,
  ): Array<Record<string, unknown>> {
    nextAttemptAt = current + JWKS_RETRY_MS;
    if (cache && cache.staleUntil > current) {
      log(`${reason} Continuing with cached signing keys.`, {
        ...fields,
        cachedKeysExpireInMs: cache.staleUntil - current,
      });
      return cache.keys;
    }
    log(`${reason} No usable cached signing keys remain; declining the request.`, fields);
    cache = undefined;
    return [];
  }

  const verify: AuthFn<Request> = async (request) => {
    const token = extractBearerToken(request.headers.get("authorization"));
    if (!token) return null;
    const decoded = decodeToken(token);
    if (!decoded) return null;
    if (!issuer || !projectId || !jwksUrl) {
      log("Eveland Identity is not configured for this Agent; declining the request.", {
        missing: [
          ...(issuer ? [] : ["EVELAND_IDENTITY_ISSUER"]),
          ...(projectId ? [] : ["EVELAND_PROJECT_ID"]),
          ...(jwksUrl ? [] : ["EVELAND_IDENTITY_JWKS_URL"]),
        ],
      });
      return null;
    }

    let jwk = (await loadKeys()).find(
      (candidate) =>
        candidate.kid === decoded.header.kid &&
        candidate.kty === "EC" &&
        candidate.alg === "ES256" &&
        candidate.use === "sig",
    );
    if (!jwk) {
      jwk = (await loadKeys(true)).find(
        (candidate) =>
          candidate.kid === decoded.header.kid &&
          candidate.kty === "EC" &&
          candidate.alg === "ES256" &&
          candidate.use === "sig",
      );
    }
    if (!jwk) return null;

    let publicKey: string;
    try {
      publicKey = createPublicKey({ key: jwk, format: "jwk" })
        .export({ type: "spki", format: "pem" })
        .toString();
    } catch (error) {
      log("Eveland Identity signing key could not be imported; declining the request.", {
        kid: decoded.header.kid,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    const audience = `eveland:project:${projectId}`;
    const verified = await verifyJwtEcdsa(token, {
      algorithm: "ES256",
      issuer,
      audiences: [audience],
      publicKey,
      clockSkewSeconds: 5,
    });
    if (!verified.ok) {
      // Eve reports only pass/fail here, so the log carries what the two sides
      // disagreed about instead of a reason. A Caller Token is bound to one
      // Project, and a mismatch looks exactly like "not our token" -- which is
      // how a wrong EVELAND_PROJECT_ID or issuer turns into a 401 nobody can
      // account for. The token-side values are from the *unverified* payload
      // and are only ever a diagnostic hint.
      log("Eveland Identity token failed verification; declining the request.", {
        kid: decoded.header.kid,
        expectedIssuer: issuer,
        expectedAudience: audience,
        tokenIssuer: decoded.payload.iss,
        tokenAudience: decoded.payload.aud,
      });
      return null;
    }

    const claims = decoded.payload;
    const nowSeconds = Math.floor(now().getTime() / 1_000);
    if (
      claims.principal_type !== "user" ||
      typeof claims.sub !== "string" ||
      !/^iprn_[0-9A-Za-z_-]+$/.test(claims.sub) ||
      typeof claims.realm_id !== "string" ||
      !/^irlm_[0-9A-Za-z_-]+$/.test(claims.realm_id) ||
      // `name` is a display claim: Eveland omits it when the IdP supplies no
      // display name. Rejecting an otherwise valid, correctly-audienced token
      // over it turned those users into an undiagnosable 401. Its type is
      // still checked when present.
      (claims.name !== undefined && (typeof claims.name !== "string" || !claims.name.trim())) ||
      (claims.email !== undefined && (typeof claims.email !== "string" || !claims.email.trim())) ||
      typeof claims.iat !== "number" ||
      claims.iat > nowSeconds + 5 ||
      typeof claims.nbf !== "number" ||
      claims.nbf > nowSeconds + 5 ||
      typeof claims.exp !== "number" ||
      claims.exp <= nowSeconds - 5 ||
      typeof claims.jti !== "string" ||
      !claims.jti
    ) {
      return null;
    }

    // Realm scoping is the Agent's call: the broker mints a valid token for
    // any enabled realm, so an Agent that serves a specific audience must say
    // so. An empty allowlist keeps the previous accept-any behavior.
    if (allowedRealms.size > 0 && !allowedRealms.has(claims.realm_id)) {
      return null;
    }

    return {
      authenticator: "eveland-identity",
      issuer,
      subject: claims.sub,
      principalId: `${issuer}:${claims.sub}`,
      principalType: "user",
      attributes: {
        realmId: claims.realm_id,
        ...(typeof claims.name === "string" ? { name: claims.name } : {}),
        ...(typeof claims.email === "string" ? { email: claims.email } : {}),
      },
    };
  };

  return withAuthChallenges(
    verify,
    issuer && projectId
      ? [
          {
            scheme: "Bearer",
            parameters: {
              realm: "eveland",
              authorization_uri: `${issuer}/identity/login`,
              project_id: projectId,
              display_name: "Eveland",
            },
          },
        ]
      : [{ scheme: "Bearer" }],
  );
}

export function parseEvelandAuthenticationChallenge(
  header: string | null,
): EvelandAuthenticationChallenge | null {
  if (!header) return null;
  const starts = [...header.matchAll(/(?:^|,\s*)(Basic|Bearer)(?:\s+|$)/gi)];
  for (let index = 0; index < starts.length; index += 1) {
    const match = starts[index]!;
    if (match[1]?.toLowerCase() !== "bearer") continue;
    const start = (match.index ?? 0) + match[0].length;
    const end = starts[index + 1]?.index ?? header.length;
    const parameters = parseChallengeParameters(header.slice(start, end));
    if (parameters.realm !== "eveland") continue;
    const projectId = parameters.project_id?.trim();
    const displayName = parameters.display_name?.trim();
    const authorizationUri = parameters.authorization_uri;
    if (!projectId || !displayName || !authorizationUri) continue;
    let url: URL;
    try {
      url = new URL(authorizationUri);
    } catch {
      continue;
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      continue;
    }
    return {
      kind: "eveland",
      url: url.toString(),
      projectId,
      displayName,
    };
  }
  return null;
}

function parseChallengeParameters(value: string): Record<string, string> {
  const parameters: Record<string, string> = {};
  const pattern = /([!#$%&'*+.^_`|~0-9A-Za-z-]+)="((?:\\.|[^"])*)"/g;
  for (const match of value.matchAll(pattern)) {
    const key = match[1]?.toLowerCase();
    const raw = match[2];
    if (!key || raw === undefined) continue;
    parameters[key] = raw.replace(/\\(.)/g, "$1");
  }
  return parameters;
}

function decodeToken(token: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
} | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as unknown;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    if (
      !isRecord(header) ||
      !isRecord(payload) ||
      header.alg !== "ES256" ||
      header.typ !== "JWT" ||
      typeof header.kid !== "string" ||
      !header.kid
    ) {
      return null;
    }
    return { header, payload };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Mirrors Eve's own auth loggers: silent unless the Agent runs with
 * `EVE_LOG_LEVEL=debug`, so one variable turns on both Eve's and Eveland's
 * authentication diagnostics.
 */
function defaultLogger(message: string, fields?: Record<string, unknown>): void {
  if (process.env.EVE_LOG_LEVEL?.toLowerCase() !== "debug") return;
  const line = `[eveland:auth.eveland-identity] ${message}`;
  if (fields === undefined) console.log(line);
  else console.log(line, fields);
}
