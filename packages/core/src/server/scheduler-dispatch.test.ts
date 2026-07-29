import { describe, expect, test } from "vitest";
import {
  createScheduleDispatchCredential,
  resolveSchedulerDispatchSecret,
  resolveSchedulerRuntimeSecret,
  verifyScheduleDispatchCredential,
} from "./scheduler-dispatch.js";

const secret = "scheduler-dispatch-secret-at-least-32-characters";
const payload = {
  scheduleRunId: "srun_test",
  deploymentId: "dep_test",
  scheduleKey: "billing/sweep",
  expiresAt: "2026-07-15T00:05:00.000Z",
};

describe("schedule dispatch credentials", () => {
  test("uses explicit secrets, explicit-development fallbacks, and fails closed otherwise", () => {
    expect(resolveSchedulerRuntimeSecret({ EVELAND_SCHEDULER_RUNTIME_SECRET: "explicit-runtime" })).toBe("explicit-runtime");
    expect(resolveSchedulerDispatchSecret({ EVELAND_SCHEDULER_DISPATCH_SECRET: "explicit-dispatch" })).toBe("explicit-dispatch");
    expect(resolveSchedulerRuntimeSecret({ NODE_ENV: "development" })).toBe("eveland-dev-scheduler-runtime-secret");
    expect(resolveSchedulerDispatchSecret({ NODE_ENV: "development" })).toBe("eveland-dev-scheduler-dispatch-secret");
    expect(resolveSchedulerRuntimeSecret({ NODE_ENV: "production" })).toBeUndefined();
    expect(resolveSchedulerDispatchSecret({ NODE_ENV: "production" })).toBeUndefined();
    // An unset NODE_ENV must fail closed: a host that forgot to set it would
    // otherwise guard privileged surfaces with publicly known dev secrets.
    expect(resolveSchedulerRuntimeSecret({})).toBeUndefined();
    expect(resolveSchedulerDispatchSecret({})).toBeUndefined();
  });

  test("round-trips a deployment- and schedule-bound credential", () => {
    const credential = createScheduleDispatchCredential(payload, secret);

    expect(verifyScheduleDispatchCredential(credential, secret, new Date("2026-07-15T00:04:59.000Z"))).toEqual(payload);
  });

  test("rejects tampering, expiration, and short secrets", () => {
    const credential = createScheduleDispatchCredential(payload, secret);

    expect(verifyScheduleDispatchCredential(`${credential}x`, secret, new Date("2026-07-15T00:04:59.000Z"))).toBeNull();
    expect(verifyScheduleDispatchCredential(credential, secret, new Date("2026-07-15T00:05:00.000Z"))).toBeNull();
    expect(() => createScheduleDispatchCredential(payload, "too-short")).toThrow(/at least 32/);
  });

  test("can authenticate a completion report after the one-time claim window expires", () => {
    const credential = createScheduleDispatchCredential(payload, secret);

    expect(
      verifyScheduleDispatchCredential(
        credential,
        secret,
        new Date("2026-07-15T00:06:00.000Z"),
        { allowExpired: true },
      ),
    ).toEqual(payload);
  });
});
