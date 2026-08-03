import { createHmac, timingSafeEqual } from "node:crypto";

const secretDerivationContext = "eveland:agent-telemetry-credential:v1";

export type AgentTelemetryCredential = {
  deploymentId: string;
  issuedAt: string;
};

/**
 * Derives the credential signing key from `APP_SECRET_KEY`. The context string
 * keeps this key separate from the secret-encryption use of the same input, so
 * agent telemetry attribution needs no additional deployment configuration.
 */
export function deriveAgentTelemetrySecret(appSecretKey: string): string {
  return createHmac("sha256", appSecretKey).update(secretDerivationContext).digest("base64url");
}

export function createAgentTelemetryCredential(
  payload: AgentTelemetryCredential,
  secret: string,
): string {
  assertPayload(payload);
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${sign(encoded, secret)}`;
}

/**
 * Returns null for any credential that is malformed or not signed by `secret`.
 *
 * `issuedAt` is carried for auditing but never enforced as an expiry: the
 * Collector owns a persistent sending queue, so a batch can legitimately arrive
 * long after the Agent produced it, and expiring credentials would drop real
 * telemetry after a Collector outage.
 */
export function verifyAgentTelemetryCredential(
  credential: string,
  secret: string,
): AgentTelemetryCredential | null {
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(credential);
  if (!match) return null;
  const [, encoded, suppliedSignature] = match;
  const suppliedBytes = Buffer.from(suppliedSignature!, "base64url");
  const expectedBytes = Buffer.from(sign(encoded!, secret), "base64url");
  if (
    suppliedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(suppliedBytes, expectedBytes)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8")) as unknown;
    assertPayload(payload);
    return payload;
  } catch {
    return null;
  }
}

function sign(encoded: string, secret: string): string {
  return createHmac("sha256", secret).update(encoded).digest("base64url");
}

function assertPayload(value: unknown): asserts value is AgentTelemetryCredential {
  const candidate = value as AgentTelemetryCredential | null;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof candidate.deploymentId !== "string" ||
    candidate.deploymentId.length === 0 ||
    typeof candidate.issuedAt !== "string" ||
    !Number.isFinite(new Date(candidate.issuedAt).getTime())
  ) {
    throw new Error("Invalid agent telemetry credential payload.");
  }
}
