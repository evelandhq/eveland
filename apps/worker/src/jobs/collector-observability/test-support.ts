import { encryptSecretValue } from "@eveland/core/server/secrets";

export const collectorAppSecretKey = "eveland-dev-secret-key-000000000";

export function encryptedCollectorConfig(config: unknown): string {
  return JSON.stringify(encryptSecretValue(JSON.stringify(config), collectorAppSecretKey));
}
