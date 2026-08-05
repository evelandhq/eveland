import { expect, test } from "vitest";
import type { IdentityBrokerOptions, IdentityBrokerPersistence } from "./index.js";

const unsupported = async (): Promise<never> => {
  throw new Error("Persistence is not exercised by this contract test.");
};

const persistence = {
  getIdentityProviderConnection: unsupported,
  listIdentityProviderConnections: unsupported,
  getIdentityRealmByExternalId: unsupported,
  createIdentityRealm: unsupported,
  upsertIdentityPrincipal: unsupported,
  createIdentitySession: unsupported,
  getActiveIdentitySession: unsupported,
  getIdentityPrincipal: unsupported,
  getIdentityRealm: unsupported,
  revokeIdentitySession: unsupported,
  getProject: unsupported,
  getIdentityReturnTargetByKey: unsupported,
  listIdentitySigningKeys: unsupported,
  getActiveIdentitySigningKey: unsupported,
  createIdentitySigningKey: unsupported,
} satisfies IdentityBrokerPersistence;

test("accepts the minimal Identity Broker persistence port", () => {
  const options = {
    store: persistence,
    issuer: "https://identity.example",
    appSecretKey: "identity-test-secret-key-0000001",
  } satisfies IdentityBrokerOptions;

  expect(options.store).toBe(persistence);
});
