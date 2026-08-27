import { expect, test } from "vitest";
import { hashModelGatewayToken, mintModelGatewayToken } from "./model-gateway-token.js";

test("minted tokens are prefixed, url-safe, and unique", () => {
  const first = mintModelGatewayToken();
  const second = mintModelGatewayToken();
  expect(first).toMatch(/^emg_[A-Za-z0-9_-]{40,}$/);
  expect(second).toMatch(/^emg_[A-Za-z0-9_-]{40,}$/);
  expect(first).not.toBe(second);
});

test("hashing is deterministic per token and never echoes the token", () => {
  const token = mintModelGatewayToken();
  const hash = hashModelGatewayToken(token);
  expect(hash).toBe(hashModelGatewayToken(token));
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  expect(hash).not.toContain(token.slice(4, 20));
  expect(hashModelGatewayToken(mintModelGatewayToken())).not.toBe(hash);
});
