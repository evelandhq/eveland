import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * The one place `APP_SECRET_KEY` becomes key material.
 *
 * Every value Eveland seals at rest uses the same envelope, and every key it
 * derives -- for sealing or for signing -- comes from `deriveAppSecretKey`
 * under an explicit purpose. HKDF-SHA256 over the normalized 32-byte key with
 * the purpose in `info` keeps the keys independent: a value sealed for one
 * purpose cannot be opened as another, and no derived key reveals the others.
 *
 * Envelope: `sealed:v2:<iv>:<authTag>:<ciphertext>`, each part base64url,
 * AES-256-GCM with a random 96-bit IV. The additional authenticated data is
 * the purpose plus an optional binding (for example the row identity a value
 * belongs to), so a sealed value moved to another row or purpose fails to open.
 * Only this version is read; there is no fallback for any other format.
 */
export const SEALED_SECRET_VERSION = 2;

const envelopePrefix = `sealed:v${SEALED_SECRET_VERSION}:`;
const hkdfSalt = Buffer.from(`eveland:app-secret:v${SEALED_SECRET_VERSION}`, "utf8");

/** Every use of `APP_SECRET_KEY`. Adding a purpose is the only way to add a use. */
export const appSecretPurposes = [
  // Project secrets and variables (`secrets.encrypted_value`).
  "project-secret",
  // The shared Agent environment's entries (`shared_agent_environment.entries`).
  "shared-agent-environment",
  // Git hosting tokens (`git_credentials`, `source_preflights`).
  "git-credential",
  // External observability destinations inside `observability_policies.document`.
  "observability-destination",
  // Agent Connection config, credentials, and OIDC transactions.
  "agent-auth-config",
  "agent-auth-credential",
  "agent-auth-transaction",
  // Identity Provider client secrets, login transactions, and signing keys.
  "identity-provider-secret",
  "identity-login-transaction",
  "identity-signing-key",
  // The HMAC key for Agent telemetry credentials (signing only, never sealed).
  "agent-telemetry-credential",
] as const;

export type AppSecretPurpose = (typeof appSecretPurposes)[number];

export type SealedSecretBinding = ReadonlyArray<string | number>;

const appSecretKeyRule = "APP_SECRET_KEY must be 32 bytes or a base64 encoded 32-byte value.";

/** Throws unless the key is 32 utf8 bytes or base64 of a 32-byte value. */
export function assertValidAppSecretKey(appSecretKey: string): void {
  normalizeAppSecretKey(appSecretKey);
}

/** The 32-byte key for one purpose. */
export function deriveAppSecretKey(appSecretKey: string, purpose: AppSecretPurpose): Buffer {
  return Buffer.from(
    hkdfSync("sha256", normalizeAppSecretKey(appSecretKey), hkdfSalt, `eveland:${purpose}`, 32),
  );
}

export function sealSecret(
  plaintext: string,
  appSecretKey: string,
  purpose: AppSecretPurpose,
  binding: SealedSecretBinding = [],
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveAppSecretKey(appSecretKey, purpose), iv);
  cipher.setAAD(additionalData(purpose, binding));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${envelopePrefix}${[iv, cipher.getAuthTag(), ciphertext]
    .map((part) => part.toString("base64url"))
    .join(":")}`;
}

/**
 * Opens a value sealed by `sealSecret` for the same purpose and binding.
 * Throws on any other format, a different key, purpose, or binding, or a
 * tampered value; the error never includes the sealed or opened value.
 */
export function openSecret(
  sealed: string,
  appSecretKey: string,
  purpose: AppSecretPurpose,
  binding: SealedSecretBinding = [],
): string {
  const parts = isSealedSecret(sealed) ? sealed.slice(envelopePrefix.length).split(":") : [];
  if (parts.length !== 3) {
    throw new Error(`Unsupported sealed value: expected a v${SEALED_SECRET_VERSION} envelope.`);
  }
  const [iv, authTag, ciphertext] = parts.map((part) => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", deriveAppSecretKey(appSecretKey, purpose), iv!);
  decipher.setAAD(additionalData(purpose, binding));
  decipher.setAuthTag(authTag!);
  return Buffer.concat([decipher.update(ciphertext!), decipher.final()]).toString("utf8");
}

/** Whether a stored value is in the current envelope format (it may still fail to open). */
export function isSealedSecret(value: string): boolean {
  return value.startsWith(envelopePrefix);
}

function additionalData(purpose: AppSecretPurpose, binding: SealedSecretBinding): Buffer {
  return Buffer.from(JSON.stringify([SEALED_SECRET_VERSION, purpose, ...binding]), "utf8");
}

function normalizeAppSecretKey(appSecretKey: string): Buffer {
  const utf8 = Buffer.from(appSecretKey, "utf8");
  if (utf8.length === 32) return utf8;
  const decoded = Buffer.from(appSecretKey, "base64");
  if (decoded.length === 32) return decoded;
  throw new Error(appSecretKeyRule);
}
