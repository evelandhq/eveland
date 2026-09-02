import { describe, expect, test } from "vitest";
import { generateAdminPassword, generateAppSecretKey, generateHexSecret } from "./secrets.ts";

describe("secret generation", () => {
  test("APP_SECRET_KEY decodes to exactly 32 bytes of base64", () => {
    const key = generateAppSecretKey();
    expect(Buffer.from(key, "base64")).toHaveLength(32);
  });

  test("hex secrets are 64 hex characters (32 bytes) and unique per call", () => {
    const a = generateHexSecret();
    const b = generateHexSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  test("generated admin passwords are 20 chars from the unambiguous alphabet", () => {
    const password = generateAdminPassword();
    expect(password).toHaveLength(20);
    expect(password).toMatch(/^[abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789]{20}$/);
    expect(password).not.toBe(generateAdminPassword());
  });
});
