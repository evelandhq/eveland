import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type EncryptedSecret = {
  algorithm: "aes-256-gcm";
  iv: string;
  authTag: string;
  ciphertext: string;
};

export function assertValidSecretKey(key: string): void {
  normalizeKey(key);
}

export function encryptSecretValue(value: string, key: string): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", normalizeKey(key), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);

  return {
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptSecretValue(secret: EncryptedSecret, key: string): string {
  const decipher = createDecipheriv("aes-256-gcm", normalizeKey(key), Buffer.from(secret.iv, "base64"));
  decipher.setAuthTag(Buffer.from(secret.authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(secret.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

export function maskKnownSecrets(input: string, values: string[]): string {
  let output = input;
  const uniqueValues = [...new Set(values.filter((value) => value.length >= 8))];

  for (const value of uniqueValues) {
    output = output.split(value).join("***");
  }

  return output;
}

export function mergeRuntimeEnvironment(input: {
  projectSecrets: Readonly<Record<string, string>>;
  projectSharedEnvironment?: Readonly<Record<string, string>>;
  deploymentSharedEnvironment?: Readonly<Record<string, string>>;
  reserved?: Readonly<Record<string, string>>;
}): Record<string, string> {
  return {
    ...input.projectSharedEnvironment,
    ...input.deploymentSharedEnvironment,
    ...input.projectSecrets,
    ...input.reserved,
  };
}

function normalizeKey(key: string): Buffer {
  const utf8 = Buffer.from(key, "utf8");
  if (utf8.length === 32) {
    return utf8;
  }

  const raw = Buffer.from(key, "base64");
  if (raw.length === 32) {
    return raw;
  }

  throw new Error("APP_SECRET_KEY must be 32 bytes or a base64 encoded 32-byte value.");
}
