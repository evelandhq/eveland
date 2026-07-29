import { createPublicKey } from "node:crypto";
import {
  UnauthenticatedError,
  extractBearerToken,
  verifyJwtEcdsa,
  withAuthChallenges,
  type AuthFn,
} from "eve/channels/auth";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type EvelandIdentityOptions = {
  issuer?: string;
  projectId?: string;
  jwksUrl?: string;
  fetch?: FetchLike;
  now?: () => Date;
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

export function evelandIdentity(
  options: EvelandIdentityOptions = {},
): AuthFn<Request> {
  const issuer = (
    options.issuer ??
    process.env.EVELAND_IDENTITY_ISSUER ??
    ""
  ).replace(/\/$/, "");
  const projectId =
    options.projectId ?? process.env.EVELAND_PROJECT_ID ?? "";
  const jwksUrl =
    options.jwksUrl ??
    process.env.EVELAND_IDENTITY_JWKS_URL ??
    (issuer ? `${issuer}/.well-known/jwks.json` : "");
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const allowedRealms = new Set(
    (options.allowedRealms ??
      (process.env.EVELAND_ALLOWED_REALM_IDS ?? "")
        .split(",")
        .map((realm) => realm.trim())
        .filter(Boolean)) as readonly string[],
  );
  let cache:
    | { expiresAt: number; keys: Array<Record<string, unknown>> }
    | undefined;

  async function loadKeys(
    force = false,
  ): Promise<Array<Record<string, unknown>>> {
    if (!force && cache && cache.expiresAt > now().getTime()) {
      return cache.keys;
    }
    let response: Response;
    try {
      response = await fetcher(jwksUrl, {
        headers: { accept: "application/json" },
        redirect: "error",
      });
    } catch {
      throw unavailable(
        "Eveland Identity signing keys are temporarily unavailable.",
      );
    }
    if (!response.ok) {
      throw unavailable(
        "Eveland Identity signing keys are temporarily unavailable.",
      );
    }
    const body = (await response.json().catch(() => null)) as
      | { keys?: unknown }
      | null;
    if (!Array.isArray(body?.keys)) {
      throw unavailable("Eveland Identity signing keys are invalid.");
    }
    const keys = body.keys.filter(isRecord);
    cache = { keys, expiresAt: now().getTime() + 60_000 };
    return keys;
  }

  const verify: AuthFn<Request> = async (request) => {
    const token = extractBearerToken(request.headers.get("authorization"));
    if (!token) return null;
    const decoded = decodeToken(token);
    if (!decoded) return null;
    if (!issuer || !projectId || !jwksUrl) {
      throw unavailable("Eveland Identity is not configured for this Agent.");
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
    } catch {
      throw unavailable("Eveland Identity signing keys are invalid.");
    }
    const verified = await verifyJwtEcdsa(token, {
      algorithm: "ES256",
      issuer,
      audiences: [`eveland:project:${projectId}`],
      publicKey,
      clockSkewSeconds: 5,
    });
    if (!verified.ok) return null;

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
      (claims.name !== undefined &&
        (typeof claims.name !== "string" || !claims.name.trim())) ||
      (claims.email !== undefined &&
        (typeof claims.email !== "string" || !claims.email.trim())) ||
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
  const starts = [
    ...header.matchAll(/(?:^|,\s*)(Basic|Bearer)(?:\s+|$)/gi),
  ];
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
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    ) {
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
    const header = JSON.parse(
      Buffer.from(parts[0], "base64url").toString("utf8"),
    ) as unknown;
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as unknown;
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

function unavailable(message: string): UnauthenticatedError {
  return new UnauthenticatedError({
    code: "eveland_identity_unavailable",
    message,
  });
}
