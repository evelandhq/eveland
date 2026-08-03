import { describe, expect, test } from "vitest";
import {
  createAgentTelemetryCredential,
  deriveAgentTelemetrySecret,
  verifyAgentTelemetryCredential,
} from "./agent-telemetry-credential.js";

const secret = deriveAgentTelemetrySecret("eveland-dev-secret-key-000000000");
const issuedAt = "2026-07-23T12:00:00.000Z";

describe("Agent telemetry credential", () => {
  test("round-trips the deployment it was issued for", () => {
    const credential = createAgentTelemetryCredential({ deploymentId: "dep_1", issuedAt }, secret);

    expect(verifyAgentTelemetryCredential(credential, secret)).toEqual({
      deploymentId: "dep_1",
      issuedAt,
    });
  });

  test("derives a key distinct from the APP_SECRET_KEY it is built from", () => {
    expect(secret).not.toBe("eveland-dev-secret-key-000000000");
    expect(deriveAgentTelemetrySecret("eveland-dev-secret-key-000000001")).not.toBe(secret);
  });

  test("rejects a payload re-signed for another deployment", () => {
    const credential = createAgentTelemetryCredential({ deploymentId: "dep_1", issuedAt }, secret);
    const [, signature] = credential.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ deploymentId: "dep_victim", issuedAt }),
      "utf8",
    ).toString("base64url");

    expect(verifyAgentTelemetryCredential(`${forgedPayload}.${signature}`, secret)).toBeNull();
  });

  test("rejects a credential signed with a different secret", () => {
    const credential = createAgentTelemetryCredential(
      { deploymentId: "dep_1", issuedAt },
      deriveAgentTelemetrySecret("eveland-dev-secret-key-000000001"),
    );

    expect(verifyAgentTelemetryCredential(credential, secret)).toBeNull();
  });

  test("rejects malformed credentials instead of throwing", () => {
    for (const candidate of ["", "no-separator", "a.b", "....", "dep_1"]) {
      expect(verifyAgentTelemetryCredential(candidate, secret)).toBeNull();
    }
  });

  /**
   * Batches replayed from the Collector's persistent queue after an outage carry
   * their original credential, so age must never invalidate one.
   */
  test("accepts a credential issued long in the past", () => {
    const credential = createAgentTelemetryCredential(
      { deploymentId: "dep_1", issuedAt: "2020-01-01T00:00:00.000Z" },
      secret,
    );

    expect(verifyAgentTelemetryCredential(credential, secret)).toMatchObject({
      deploymentId: "dep_1",
    });
  });
});
