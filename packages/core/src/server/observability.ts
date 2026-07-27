import {
  externalDestinationConfigSchema,
  type ExternalDestinationConfig,
} from "../observability.js";
import {
  decryptSecretValue,
  encryptSecretValue,
  type EncryptedSecret,
} from "./secrets.js";

/**
 * A destination configuration is stored as one sealed blob so that adding a credential
 * field never widens the plaintext surface. API and Worker share this pair: the API seals
 * what the Admin submits, the Worker opens it to render Collector exporters and to probe
 * destination health.
 */
export function encryptDestinationConfig(
  config: ExternalDestinationConfig,
  appSecretKey: string,
): string {
  return JSON.stringify(
    encryptSecretValue(JSON.stringify(config), appSecretKey),
  );
}

export function decryptDestinationConfig(
  encryptedConfig: string,
  appSecretKey: string,
): ExternalDestinationConfig {
  try {
    const encrypted = JSON.parse(encryptedConfig) as EncryptedSecret;
    return externalDestinationConfigSchema.parse(
      JSON.parse(decryptSecretValue(encrypted, appSecretKey)),
    );
  } catch {
    throw new Error("Could not decrypt an observability destination.");
  }
}
