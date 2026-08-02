import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import {
  callerTokenAudience,
  identityAppTokenAudience,
  type IdentityPrincipal,
  type IdentityProviderConnection,
  type IdentityRealm,
  type IdentityReturnTarget,
  type IdentitySession,
  type IdentitySigningKey,
  type IdentitySigningKeyStatus,
  type ResolvedExternalIdentity,
} from "@eveland/core/identity";
import type { Project } from "@eveland/core/contracts";

export class IdentityBrokerError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
    this.name = "IdentityBrokerError";
  }
}

export type IdentityBrokerPersistence = {
  getIdentityProviderConnection(
    id: string,
  ): Promise<IdentityProviderConnection | null>;
  getIdentityRealmByExternalId(
    providerConnectionId: string,
    externalRealmId: string,
  ): Promise<IdentityRealm | null>;
  upsertIdentityPrincipal(input: {
    identityRealmId: string;
    externalSubject: string;
    displayName: string | null;
    email: string | null;
    claims: Record<string, string | readonly string[]>;
  }): Promise<IdentityPrincipal>;
  createIdentitySession(input: {
    tokenHash: string;
    identityPrincipalId: string;
    activeIdentityRealmId: string;
    expiresAt: Date;
  }): Promise<IdentitySession>;
  getActiveIdentitySession(
    tokenHash: string,
    now?: Date,
  ): Promise<IdentitySession | null>;
  getIdentityPrincipal(id: string): Promise<IdentityPrincipal | null>;
  getIdentityRealm(id: string): Promise<IdentityRealm | null>;
  revokeIdentitySession(
    id: string,
    now?: Date,
  ): Promise<IdentitySession | null>;
  getProject(
    projectId: string,
  ): Promise<Pick<Project, "id" | "deletionStatus"> | null>;
  getIdentityReturnTargetByKey(
    key: string,
  ): Promise<IdentityReturnTarget | null>;
  listIdentitySigningKeys(): Promise<IdentitySigningKey[]>;
  getActiveIdentitySigningKey(now?: Date): Promise<IdentitySigningKey | null>;
  createIdentitySigningKey(input: {
    id?: string;
    algorithm: "ES256";
    publicJwk: Record<string, unknown>;
    privateKeyEncrypted: string;
    status: IdentitySigningKeyStatus;
    notBefore: Date;
    expiresAt: Date;
  }): Promise<IdentitySigningKey>;
};

export type IdentityBrokerOptions = {
  store: IdentityBrokerPersistence;
  issuer: string;
  appSecretKey: string;
  now?: () => Date;
  identitySessionTtlSeconds?: number;
  callerTokenTtlSeconds?: number;
  appTokenTtlSeconds?: number;
};

export function createIdentityBroker(options: IdentityBrokerOptions) {
  assertStrongAppSecretKey(options.appSecretKey);
  const now = options.now ?? (() => new Date());
  const identitySessionTtlSeconds = options.identitySessionTtlSeconds ?? 30 * 24 * 60 * 60;
  const callerTokenTtlSeconds = options.callerTokenTtlSeconds ?? 60;
  const appTokenTtlSeconds = options.appTokenTtlSeconds ?? 5 * 60;
  const issuer = options.issuer.replace(/\/$/, "");

  async function finalizeIdentity(input: {
    providerConnectionId: string;
    providerSecurityRevision: number;
    identity: ResolvedExternalIdentity;
  }) {
    const connection = await options.store.getIdentityProviderConnection(
      input.providerConnectionId,
    );
    if (
      !connection ||
      !connection.enabled ||
      connection.securityRevision !== input.providerSecurityRevision
    ) {
      throw new IdentityBrokerError(
        "identity_provider_invalid",
        401,
        "The Identity Provider Connection is no longer valid.",
      );
    }
    const realm = await options.store.getIdentityRealmByExternalId(
      connection.id,
      input.identity.externalRealmId,
    );
    if (
      !realm ||
      !realm.enabled ||
      realm.externalRealmKind !== input.identity.externalRealmKind
    ) {
      throw new IdentityBrokerError(
        "identity_realm_not_allowed",
        403,
        "This identity scope is not allowed.",
      );
    }

    const principal = await options.store.upsertIdentityPrincipal({
      identityRealmId: realm.id,
      externalSubject: requiredIdentityValue(
        input.identity.externalSubject,
        "External subject",
      ),
      displayName: optionalIdentityValue(input.identity.displayName),
      email: optionalIdentityValue(input.identity.email),
      claims: {},
    });
    const sessionToken = randomBytes(32).toString("base64url");
    const current = now();
    const session = await options.store.createIdentitySession({
      tokenHash: hashIdentityToken(sessionToken),
      identityPrincipalId: principal.id,
      activeIdentityRealmId: realm.id,
      expiresAt: new Date(
        current.getTime() + identitySessionTtlSeconds * 1_000,
      ),
    });
    return { sessionToken, session, principal, realm };
  }

  async function resolveSession(sessionToken: string) {
    if (!sessionToken) {
      throw new IdentityBrokerError(
        "identity_session_invalid",
        401,
        "An Eveland Identity Session is required.",
      );
    }
    const session = await options.store.getActiveIdentitySession(
      hashIdentityToken(sessionToken),
      now(),
    );
    if (!session) {
      throw new IdentityBrokerError(
        "identity_session_invalid",
        401,
        "The Eveland Identity Session is missing, expired, or revoked.",
      );
    }
    const principal = await options.store.getIdentityPrincipal(
      session.identityPrincipalId,
    );
    const realm = await options.store.getIdentityRealm(
      session.activeIdentityRealmId,
    );
    const connection = realm
      ? await options.store.getIdentityProviderConnection(
          realm.providerConnectionId,
        )
      : null;
    if (
      !principal ||
      !realm ||
      !realm.enabled ||
      principal.identityRealmId !== realm.id ||
      !connection ||
      !connection.enabled
    ) {
      await options.store.revokeIdentitySession(session.id, now());
      throw new IdentityBrokerError(
        "identity_session_invalid",
        401,
        "The Eveland Identity Session is no longer active.",
      );
    }
    return { session, principal, realm };
  }

  async function issueCallerToken(input: {
    sessionToken: string;
    projectId: string;
    agentUrl?: string;
  }) {
    const resolved = await resolveSession(input.sessionToken);
    const project = await options.store.getProject(input.projectId);
    if (!project || project.deletionStatus) {
      throw new IdentityBrokerError(
        "identity_project_not_found",
        404,
        "The requested Project does not exist.",
      );
    }
    const current = now();
    const issuedAt = Math.floor(current.getTime() / 1_000);
    const expiresAt = new Date(current.getTime() + callerTokenTtlSeconds * 1_000);
    const payload = {
      iss: issuer,
      sub: resolved.principal.id,
      aud: callerTokenAudience(project.id),
      principal_type: "user",
      realm_id: resolved.realm.id,
      ...(resolved.principal.displayName
        ? { name: resolved.principal.displayName }
        : {}),
      ...(resolved.principal.email ? { email: resolved.principal.email } : {}),
      ...(input.agentUrl ? { agent_url: input.agentUrl } : {}),
      iat: issuedAt,
      nbf: issuedAt,
      exp: Math.floor(expiresAt.getTime() / 1_000),
      jti: randomBytes(16).toString("base64url"),
    };

    return {
      token: await signIdentityJwt(options, now, payload),
      expiresAt: expiresAt.toISOString(),
      principal: {
        id: resolved.principal.id,
        name: resolved.principal.displayName,
      },
    };
  }

  async function issueAppToken(input: {
    sessionToken: string;
    targetKey: string;
    origin: string;
  }) {
    const resolved = await resolveSession(input.sessionToken);
    const target = await options.store.getIdentityReturnTargetByKey(
      input.targetKey,
    );
    if (!target?.enabled || target.origin !== input.origin) {
      throw new IdentityBrokerError(
        "identity_return_target_invalid",
        403,
        "This origin cannot receive an Eveland app token.",
      );
    }
    const current = now();
    const issuedAt = Math.floor(current.getTime() / 1_000);
    const expiresAt = new Date(current.getTime() + appTokenTtlSeconds * 1_000);
    const payload = {
      iss: issuer,
      sub: resolved.principal.id,
      aud: identityAppTokenAudience(target.key),
      principal_type: "user",
      realm_id: resolved.realm.id,
      iat: issuedAt,
      nbf: issuedAt,
      exp: Math.floor(expiresAt.getTime() / 1_000),
      jti: randomBytes(16).toString("base64url"),
    };
    return {
      token: await signIdentityJwt(options, now, payload),
      expiresAt: expiresAt.toISOString(),
    };
  }

  async function getJwks() {
    const current = now().getTime();
    const keys = (await options.store.listIdentitySigningKeys())
      .filter(
        (key) =>
          (key.status === "active" || key.status === "retiring") &&
          new Date(key.expiresAt).getTime() > current,
      )
      .map((key) => ({
        ...key.publicJwk,
        kid: key.id,
        alg: key.algorithm,
        use: "sig",
      }));
    return { keys };
  }

  async function resolveReturnTarget(targetKey: string, returnPath: string) {
    assertRelativeReturnPath(returnPath);
    const target = await options.store.getIdentityReturnTargetByKey(targetKey);
    if (!target?.enabled) {
      throw new IdentityBrokerError(
        "identity_return_target_invalid",
        400,
        "The Identity return target is not registered.",
      );
    }
    let origin: URL;
    try {
      origin = new URL(target.origin);
    } catch {
      throw new IdentityBrokerError(
        "identity_return_target_invalid",
        400,
        "The Identity return target is invalid.",
      );
    }
    return new URL(returnPath, `${origin.origin}/`).toString();
  }

  return {
    finalizeIdentity,
    resolveSession,
    issueCallerToken,
    issueAppToken,
    getJwks,
    resolveReturnTarget,
  };
}

async function signIdentityJwt(
  options: IdentityBrokerOptions,
  now: () => Date,
  payload: Record<string, unknown>,
): Promise<string> {
  const key = await ensureActiveSigningKey(options, now());
  const encodedHeader = encodeJson({
    alg: "ES256",
    typ: "JWT",
    kid: key.id,
  });
  const encodedPayload = encodeJson(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const privateKey = openPrivateKey(
    key.privateKeyEncrypted,
    options.appSecretKey,
    key.id,
  );
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${signingInput}.${signature}`;
}

export function hashIdentityToken(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("base64url")}`;
}

function assertRelativeReturnPath(value: string): void {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new IdentityBrokerError(
      "identity_return_target_invalid",
      400,
      "Identity return path must be a safe relative path.",
    );
  }
}

async function ensureActiveSigningKey(
  options: IdentityBrokerOptions,
  current: Date,
) {
  const existing = await options.store.getActiveIdentitySigningKey(current);
  if (existing) return existing;
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const id = `isky_${randomBytes(10).toString("base64url")}`;
  const publicJwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  return options.store.createIdentitySigningKey({
    id,
    algorithm: "ES256",
    publicJwk: { ...publicJwk, kid: id, alg: "ES256", use: "sig" },
    privateKeyEncrypted: sealPrivateKey(
      privatePem,
      options.appSecretKey,
      id,
    ),
    status: "active",
    notBefore: new Date(current.getTime() - 1_000),
    expiresAt: new Date(current.getTime() + 90 * 24 * 60 * 60 * 1_000),
  });
}

function sealPrivateKey(value: string, appSecretKey: string, keyId: string): string {
  const key = identitySigningEncryptionKey(appSecretKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`eveland:identity:signing-key:v1:${keyId}`));
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return JSON.stringify({
    version: 1,
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  });
}

function openPrivateKey(value: string, appSecretKey: string, keyId: string): string {
  const parsed = JSON.parse(value) as {
    version: number;
    iv: string;
    authTag: string;
    ciphertext: string;
  };
  if (parsed.version !== 1) throw new Error("Unsupported Identity signing key.");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    identitySigningEncryptionKey(appSecretKey),
    Buffer.from(parsed.iv, "base64url"),
  );
  decipher.setAAD(Buffer.from(`eveland:identity:signing-key:v1:${keyId}`));
  decipher.setAuthTag(Buffer.from(parsed.authTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(parsed.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

// Same strength rule as every other APP_SECRET_KEY consumer (core/server
// secrets, agent-auth sealed credential/config/transaction): 32 utf8 bytes,
// or base64 of a 32-byte value.
function assertStrongAppSecretKey(appSecretKey: string): void {
  const utf8 = Buffer.from(appSecretKey, "utf8");
  if (utf8.length === 32) return;
  const decoded = Buffer.from(appSecretKey, "base64");
  if (decoded.length === 32) return;
  throw new Error("APP_SECRET_KEY must be 32 bytes or a base64 encoded 32-byte value.");
}

function identitySigningEncryptionKey(appSecretKey: string): Buffer {
  // Deliberately derives from the raw string (not the base64-decoded bytes
  // like the other envelope homes): v1 signing-key envelopes were sealed this
  // way, and changing the derivation input would orphan every persisted
  // Identity signing key. Normalize only alongside a versioned envelope
  // migration when the sealed-envelope implementations are unified.
  return createHmac("sha256", appSecretKey)
    .update("eveland:identity:signing-key:v1")
    .digest();
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function requiredIdentityValue(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new IdentityBrokerError(
      "identity_provider_response_invalid",
      401,
      `${label} is missing from the verified provider identity.`,
    );
  }
  return normalized;
}

function optionalIdentityValue(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
