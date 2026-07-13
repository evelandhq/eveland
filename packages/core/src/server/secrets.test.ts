import { describe, expect, test } from "vitest";
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

    expect(maskKnownSecrets(log, ["sk-test-123", "", "abc"])).toBe("OPENAI_API_KEY=***\nEMPTY=\nshort=abc");
  });
});
