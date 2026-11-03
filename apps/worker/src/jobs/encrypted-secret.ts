import type { EncryptedSecret } from "@evelandhq/core/server/secrets";

/** Parses a stored `JSON.stringify(encryptSecretValue(...))` payload. */
export function parseEncryptedSecret(value: string): EncryptedSecret {
  const parsed = JSON.parse(value) as Partial<EncryptedSecret>;
  if (parsed.algorithm !== "aes-256-gcm" || !parsed.iv || !parsed.authTag || !parsed.ciphertext) {
    throw new Error("Invalid encrypted secret payload.");
  }
  return parsed as EncryptedSecret;
}
