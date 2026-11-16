import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  assertValidAppSecretKey,
  deriveAppSecretKey,
  isSealedSecret,
  openSecret,
  sealSecret,
} from "./sealed-secret.js";

const key = "0123456789abcdef0123456789abcdef";
const base64Key = Buffer.from(key, "utf8").toString("base64");
const otherKey = "fedcba9876543210fedcba9876543210";

describe("sealed secret envelope", () => {
  test("round-trips without storing plaintext, in the versioned envelope", () => {
    const sealed = sealSecret("sk-test-123", key, "project-secret");

    expect(sealed).toMatch(/^sealed:v2:[\w-]+:[\w-]+:[\w-]+$/);
    expect(sealed).not.toContain("sk-test-123");
    expect(isSealedSecret(sealed)).toBe(true);
    expect(openSecret(sealed, key, "project-secret")).toBe("sk-test-123");
  });

  test("accepts the same key in utf8 or base64 form", () => {
    expect(
      openSecret(sealSecret("value", key, "git-credential"), base64Key, "git-credential"),
    ).toBe("value");
  });

  test("seals the same value differently each time", () => {
    expect(sealSecret("value", key, "project-secret")).not.toBe(
      sealSecret("value", key, "project-secret"),
    );
  });

  test("refuses another key, another purpose, and another binding", () => {
    const sealed = sealSecret("value", key, "agent-auth-config", ["conn_1", "oidc", 1]);

    expect(() =>
      openSecret(sealed, otherKey, "agent-auth-config", ["conn_1", "oidc", 1]),
    ).toThrow();
    expect(() => openSecret(sealed, key, "agent-auth-credential", ["conn_1", "oidc", 1])).toThrow();
    expect(() => openSecret(sealed, key, "agent-auth-config", ["conn_2", "oidc", 1])).toThrow();
    expect(() => openSecret(sealed, key, "agent-auth-config", ["conn_1", "oidc", 2])).toThrow();
    expect(openSecret(sealed, key, "agent-auth-config", ["conn_1", "oidc", 1])).toBe("value");
  });

  test("refuses a tampered ciphertext", () => {
    const sealed = sealSecret("value", key, "project-secret");
    const parts = sealed.split(":");
    const ciphertext = Buffer.from(parts[4]!, "base64url");
    ciphertext[0] = ciphertext[0]! ^ 0xff;
    parts[4] = ciphertext.toString("base64url");

    expect(() => openSecret(parts.join(":"), key, "project-secret")).toThrow();
  });

  test("reads no other format, and names neither value in the error", () => {
    // The pre-envelope shape: a JSON AES-GCM blob under the raw key.
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "utf8"), iv);
    const legacy = JSON.stringify({
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      ciphertext: Buffer.concat([cipher.update("sk-legacy-123"), cipher.final()]).toString(
        "base64",
      ),
      authTag: cipher.getAuthTag().toString("base64"),
    });

    expect(isSealedSecret(legacy)).toBe(false);
    expect(() => openSecret(legacy, key, "project-secret")).toThrow(
      "Unsupported sealed value: expected a v2 envelope.",
    );
    expect(() => openSecret("sealed:v2:only-two:parts", key, "project-secret")).toThrow(
      "Unsupported sealed value: expected a v2 envelope.",
    );
  });

  test("derives independent 32-byte keys per purpose", () => {
    const sealing = deriveAppSecretKey(key, "project-secret");
    const signing = deriveAppSecretKey(key, "agent-telemetry-credential");

    expect(sealing).toHaveLength(32);
    expect(signing).toHaveLength(32);
    expect(sealing.equals(signing)).toBe(false);
    expect(sealing.equals(Buffer.from(key, "utf8"))).toBe(false);
    expect(deriveAppSecretKey(base64Key, "project-secret").equals(sealing)).toBe(true);
  });

  test("rejects a key that is neither 32 bytes nor base64 of 32 bytes", () => {
    const rule = "APP_SECRET_KEY must be 32 bytes or a base64 encoded 32-byte value.";
    expect(() => assertValidAppSecretKey("too-short")).toThrow(rule);
    expect(() => sealSecret("value", "too-short", "project-secret")).toThrow(rule);
    expect(() => assertValidAppSecretKey(key)).not.toThrow();
    expect(() => assertValidAppSecretKey(base64Key)).not.toThrow();
  });
});
