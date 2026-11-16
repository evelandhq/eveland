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

describe("admin password sampling", () => {
  // 256 is not a multiple of the 56-character alphabet, so `byte % 56` made
  // the first 32 characters likelier than the rest. Bytes past the last whole
  // multiple are drawn again instead.
  test("draws again for bytes that would bias the alphabet", () => {
    const draws: Buffer[] = [Buffer.alloc(20, 255), Buffer.alloc(20, 1)];
    const password = generateAdminPassword(() => draws.shift() ?? Buffer.alloc(20, 1));
    expect(password).toBe("b".repeat(20));
  });

  test("keeps every accepted byte", () => {
    expect(
      generateAdminPassword(() => Buffer.from(Array.from({ length: 20 }, (_, i) => 223 - i))),
    ).toBe(
      Array.from(
        { length: 20 },
        (_, i) => "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"[(223 - i) % 56],
      ).join(""),
    );
  });
});
