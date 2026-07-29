import { createHmac, timingSafeEqual } from "node:crypto";
import { resolveSecretWithDevFallback } from "./dev-secrets.js";

const developmentRuntimeSecret = "eveland-dev-scheduler-runtime-secret";
const developmentDispatchSecret = "eveland-dev-scheduler-dispatch-secret";

export type ScheduleDispatchCredential = {
  scheduleRunId: string;
  deploymentId: string;
  scheduleKey: string;
  expiresAt: string;
};

export function resolveSchedulerRuntimeSecret(env: NodeJS.ProcessEnv): string | undefined {
  return resolveSecretWithDevFallback(env, env.EVELAND_SCHEDULER_RUNTIME_SECRET, developmentRuntimeSecret);
}

export function resolveSchedulerDispatchSecret(env: NodeJS.ProcessEnv): string | undefined {
  return resolveSecretWithDevFallback(env, env.EVELAND_SCHEDULER_DISPATCH_SECRET, developmentDispatchSecret);
}

export function createScheduleDispatchCredential(payload: ScheduleDispatchCredential, secret: string): string {
  assertDispatchSecret(secret);
  assertPayload(payload);
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${sign(encoded, secret)}`;
}

export function verifyScheduleDispatchCredential(
  credential: string,
  secret: string,
  now = new Date(),
  options: { allowExpired?: boolean } = {},
): ScheduleDispatchCredential | null {
  assertDispatchSecret(secret);
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(credential);
  if (!match) return null;
  const [, encoded, suppliedSignature] = match;
  const expectedSignature = sign(encoded!, secret);
  const suppliedBytes = Buffer.from(suppliedSignature!, "base64url");
  const expectedBytes = Buffer.from(expectedSignature, "base64url");
  if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8")) as unknown;
    assertPayload(payload);
    return options.allowExpired || new Date(payload.expiresAt).getTime() > now.getTime() ? payload : null;
  } catch {
    return null;
  }
}

function sign(encoded: string, secret: string): string {
  return createHmac("sha256", secret).update(encoded).digest("base64url");
}

function assertDispatchSecret(secret: string): void {
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("EVELAND_SCHEDULER_DISPATCH_SECRET must be at least 32 bytes.");
  }
}

function assertPayload(value: unknown): asserts value is ScheduleDispatchCredential {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as ScheduleDispatchCredential).scheduleRunId !== "string" ||
    typeof (value as ScheduleDispatchCredential).deploymentId !== "string" ||
    typeof (value as ScheduleDispatchCredential).scheduleKey !== "string" ||
    typeof (value as ScheduleDispatchCredential).expiresAt !== "string" ||
    !Number.isFinite(new Date((value as ScheduleDispatchCredential).expiresAt).getTime())
  ) {
    throw new Error("Invalid schedule dispatch credential payload.");
  }
}
