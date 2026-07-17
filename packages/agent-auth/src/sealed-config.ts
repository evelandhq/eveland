export type AgentAuthConfigBinding = {
  agentConnectionId: string;
  method: string;
  securityRevision: number;
};

type SealedConfigEnvelope = {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  authTag: string;
  ciphertext: string;
};

export function sealAgentAuthConfig(config: unknown, appSecretKey: string, binding: AgentAuthConfigBinding): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(appSecretKey), iv);
  cipher.setAAD(configAad(binding));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(config), "utf8"), cipher.final()]);
  return JSON.stringify({
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  } satisfies SealedConfigEnvelope);
}

export function openAgentAuthConfig(value: string, appSecretKey: string, binding: AgentAuthConfigBinding): unknown {
  const envelope = parseEnvelope(value);
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(appSecretKey), Buffer.from(envelope.iv, "base64"));
  decipher.setAAD(configAad(binding));
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext) as unknown;
}

function deriveKey(appSecretKey: string): Buffer {
  return createHmac("sha256", normalizeAppSecretKey(appSecretKey))
    .update("eveland:agent-auth:config:v1")
    .digest();
}

function normalizeAppSecretKey(value: string): Buffer {
  const utf8 = Buffer.from(value, "utf8");
  if (utf8.length === 32) return utf8;
  const base64 = Buffer.from(value, "base64");
  if (base64.length === 32) return base64;
  throw new Error("APP_SECRET_KEY must be 32 bytes or a base64 encoded 32-byte value.");
}

function configAad(binding: AgentAuthConfigBinding): Buffer {
  return Buffer.from(JSON.stringify([
    "config",
    binding.agentConnectionId,
    binding.method,
    binding.securityRevision,
  ]));
}

function parseEnvelope(value: string): SealedConfigEnvelope {
  const parsed = JSON.parse(value) as Partial<SealedConfigEnvelope>;
  if (
    parsed.version !== 1
    || parsed.algorithm !== "aes-256-gcm"
    || typeof parsed.iv !== "string"
    || typeof parsed.authTag !== "string"
    || typeof parsed.ciphertext !== "string"
  ) {
    throw new Error("Invalid sealed Agent Auth config.");
  }
  return parsed as SealedConfigEnvelope;
}
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
