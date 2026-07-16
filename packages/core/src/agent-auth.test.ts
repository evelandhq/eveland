import { describe, expect, test } from "vitest";
import { decodeAgentAuthEnvelope, encodeAgentAuthEnvelope } from "./agent-auth.js";

describe("Agent Auth credential envelope", () => {
  test("accepts an Agent authorization header", () => {
    const encoded = encodeAgentAuthEnvelope({
      version: 1,
      authority: "canonical",
      headers: [["authorization", "Bearer agent-token"]],
    });

    expect(decodeAgentAuthEnvelope(encoded)).toEqual({
      version: 1,
      authority: "canonical",
      headers: [["authorization", "Bearer agent-token"]],
    });
  });

  test.each(["host", "content-length", "forwarded", "x-forwarded-host", "x-eveland-project-id", "proxy-authorization"])(
    "rejects reserved credential header %s",
    (name) => {
      expect(() => encodeAgentAuthEnvelope({
        version: 1,
        authority: "canonical",
        headers: [[name, "unsafe"]],
      })).toThrow(/credential header/i);
    },
  );

  test("rejects malformed header names and values", () => {
    expect(() => encodeAgentAuthEnvelope({
      version: 1,
      authority: "canonical",
      headers: [["not a header", "value"]],
    })).toThrow(/credential header/i);
    expect(() => encodeAgentAuthEnvelope({
      version: 1,
      authority: "canonical",
      headers: [["x-api-key", "value\r\ninjected: true"]],
    })).toThrow(/credential header/i);
  });
});
