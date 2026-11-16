import { sealSecret } from "@evelandhq/core/server/sealed-secret";

export const collectorAppSecretKey = "eveland-dev-secret-key-000000000";

export function encryptedCollectorConfig(config: unknown): string {
  return sealSecret(JSON.stringify(config), collectorAppSecretKey, "observability-destination");
}
