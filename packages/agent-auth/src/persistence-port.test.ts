import { expect, test } from "vitest";
import type {
  OidcAuthorizationCodePersistence,
  OidcAuthorizationCodeProviderOptions,
} from "./oidc.js";

const unsupported = async (): Promise<never> => {
  throw new Error("Persistence is not exercised by this contract test.");
};

const persistence = {
  getAgentAuthCredential: unsupported,
  putAgentAuthCredential: unsupported,
  deleteAgentAuthCredential: unsupported,
  replaceAgentAuthCredential: unsupported,
  claimAgentAuthCredentialRefresh: unsupported,
  completeAgentAuthCredentialRefresh: unsupported,
  releaseAgentAuthCredentialRefresh: unsupported,
  createAgentAuthTransaction: unsupported,
  consumeAgentAuthTransaction: unsupported,
  deleteExpiredAgentAuthTransactions: unsupported,
} satisfies OidcAuthorizationCodePersistence;

test("accepts the minimal OIDC persistence port", () => {
  const options = {
    store: persistence,
    appSecretKey: "0123456789abcdef0123456789abcdef",
    callbackUrl: "https://eveland.example/oidc/callback",
    resolveClientSecret: async () => undefined,
  } satisfies OidcAuthorizationCodeProviderOptions;

  expect(options.store).toBe(persistence);
});
