export type AgentAuthCredentialBinding = {
  agentConnectionId: string;
  securityRevision: number;
  authMethod: string;
  credentialScope: "connection" | "principal";
  scopeSubject: string;
  credentialKey: string;
};

export function sealAgentAuthCredential(
  credential: unknown,
  appSecretKey: string,
  binding: AgentAuthCredentialBinding,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(appSecretKey), iv);
  cipher.setAAD(credentialAad(binding));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credential), "utf8"),
    cipher.final(),
  ]);
  return JSON.stringify({
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  } satisfies SealedCredentialEnvelope);
}

export function openAgentAuthCredential(
  value: string,
  appSecretKey: string,
  binding: AgentAuthCredentialBinding,
): unknown {
  const envelope = parseEnvelope(value);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveKey(appSecretKey),
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAAD(credentialAad(binding));
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext) as unknown;
}

type SealedCredentialEnvelope = {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  authTag: string;
  ciphertext: string;
};

function deriveKey(appSecretKey: string): Buffer {
  const utf8 = Buffer.from(appSecretKey, "utf8");
  const normalized = utf8.length === 32 ? utf8 : Buffer.from(appSecretKey, "base64");
  if (normalized.length !== 32)
    throw new Error("APP_SECRET_KEY must be 32 bytes or a base64 encoded 32-byte value.");
  return createHmac("sha256", normalized).update("eveland:agent-auth:credential:v1").digest();
}

function credentialAad(binding: AgentAuthCredentialBinding): Buffer {
  return Buffer.from(
    JSON.stringify([
      "credential",
      binding.agentConnectionId,
      binding.securityRevision,
      binding.authMethod,
      binding.credentialScope,
      binding.scopeSubject,
      binding.credentialKey,
    ]),
  );
}

function parseEnvelope(value: string): SealedCredentialEnvelope {
  const parsed = JSON.parse(value) as Partial<SealedCredentialEnvelope>;
  if (
    parsed.version !== 1 ||
    parsed.algorithm !== "aes-256-gcm" ||
    typeof parsed.iv !== "string" ||
    typeof parsed.authTag !== "string" ||
    typeof parsed.ciphertext !== "string"
  )
    throw new Error("Invalid sealed Agent credential.");
  return parsed as SealedCredentialEnvelope;
}
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
