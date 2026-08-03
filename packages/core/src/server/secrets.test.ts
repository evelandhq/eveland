import { describe, expect, test } from "vitest";
import * as secrets from "./secrets.js";
import { decryptSecretValue, encryptSecretValue, maskKnownSecrets } from "./secrets.js";

const key = "0123456789abcdef0123456789abcdef";

describe("secret encryption", () => {
  test("encrypts without storing plaintext and decrypts with the same key", () => {
    const encrypted = encryptSecretValue("sk-test-123", key);

    expect(encrypted.ciphertext).not.toContain("sk-test-123");
    expect(decryptSecretValue(encrypted, key)).toBe("sk-test-123");
  });

  test("masks known non-empty secret values in logs", () => {
    const log = "OPENAI_API_KEY=sk-test-123\nEMPTY=\nshort=abc";

    expect(maskKnownSecrets(log, ["sk-test-123", "", "abc"])).toBe(
      "OPENAI_API_KEY=***\nEMPTY=\nshort=abc",
    );
  });

  test("uses the shared Agent environment as a fallback for Project Secrets", () => {
    const mergeRuntimeEnvironment = (secrets as Record<string, unknown>).mergeRuntimeEnvironment;

    expect(mergeRuntimeEnvironment).toBeTypeOf("function");
    expect(
      (mergeRuntimeEnvironment as (input: unknown) => unknown)({
        projectSecrets: { SHARED: "project", PROJECT_ONLY: "project" },
        sharedEnvironment: { SHARED: "shared", SHARED_ONLY: "shared" },
        reserved: { SHARED: "reserved", NODE_ENV: "production" },
      }),
    ).toEqual({
      SHARED: "reserved",
      PROJECT_ONLY: "project",
      SHARED_ONLY: "shared",
      NODE_ENV: "production",
    });

    expect(
      (mergeRuntimeEnvironment as (input: unknown) => Record<string, string>)({
        projectSecrets: { OPENAI_API_KEY: "project-key" },
        sharedEnvironment: { OPENAI_API_KEY: "shared-key" },
      }).OPENAI_API_KEY,
    ).toBe("project-key");
  });
});
