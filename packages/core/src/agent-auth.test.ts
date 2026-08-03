import { describe, expect, test } from "vitest";
import {
  decodeAgentAuthEnvelope,
  encodeAgentAuthEnvelope,
  parseAgentCredentialHeaders,
} from "./agent-auth.js";

describe("Agent Auth credential envelope", () => {
  test("round-trips a versioned canonical credential without changing header values", () => {
    const encoded = encodeAgentAuthEnvelope({
      version: 1,
      authority: "canonical",
      headers: [["authorization", "Bearer café-token"]],
    });

    expect(decodeAgentAuthEnvelope(encoded)).toEqual({
      version: 1,
      authority: "canonical",
      headers: [["authorization", "Bearer café-token"]],
    });
  });

  test.each([
    "host",
    "content-length",
    "forwarded",
    "x-forwarded-host",
    "x-eveland-project-id",
    "proxy-authorization",
    "connection",
  ])("rejects reserved credential header %s", (name) => {
    expect(() => parseAgentCredentialHeaders([[name, "unsafe"]])).toThrow(/credential header/i);
  });

  test("rejects malformed, injected, and duplicate credential headers", () => {
    expect(() => parseAgentCredentialHeaders([["not a header", "value"]])).toThrow(
      /credential header/i,
    );
    expect(() => parseAgentCredentialHeaders([["x-api-key", "value\r\ninjected: true"]])).toThrow(
      /credential header/i,
    );
    expect(() =>
      parseAgentCredentialHeaders([
        ["Authorization", "Bearer first"],
        ["authorization", "Bearer second"],
      ]),
    ).toThrow(/duplicate/i);
  });

  test("rejects malformed and unsupported envelopes", () => {
    expect(() => decodeAgentAuthEnvelope("not-base64-json")).toThrow();
    const unsupported = Buffer.from(
      JSON.stringify({ version: 2, authority: "canonical", headers: [] }),
    ).toString("base64url");
    expect(() => decodeAgentAuthEnvelope(unsupported)).toThrow();
  });
});
