import { describe, expect, test, vi } from "vitest";
import type { ActivationClient } from "./activation-client.js";
import { withRenewedLease } from "./lease.js";

function client(overrides: Partial<ActivationClient> = {}): ActivationClient {
  return {
    activate: vi.fn(),
    renew: vi.fn(async () => true),
    release: vi.fn(async () => {}),
    ...overrides,
  } as ActivationClient;
}

/**
 * Lease renewal is what lets a step outlive the 180s activation TTL. Without
 * it the idle reaper stops the executor mid-step — the exact failure this whole
 * project exists to remove, reintroduced one layer up.
 */
describe("withRenewedLease", () => {
  test("renews while the body is still running", async () => {
    vi.useFakeTimers();
    try {
      const activation = client();
      let release!: () => void;
      const body = new Promise<string>((resolve) => {
        release = () => resolve("done");
      });

      const promise = withRenewedLease(
        { client: activation, leaseId: "lease_1", renewIntervalMs: 1_000 },
        () => body,
      );

      await vi.advanceTimersByTimeAsync(3_500);
      expect(activation.renew).toHaveBeenCalledTimes(3);

      release();
      await expect(promise).resolves.toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });

  test("stops renewing and releases once the body settles", async () => {
    vi.useFakeTimers();
    try {
      const activation = client();
      await withRenewedLease(
        { client: activation, leaseId: "lease_1", renewIntervalMs: 1_000 },
        async () => "ok",
      );
      const callsAtFinish = (activation.renew as ReturnType<typeof vi.fn>).mock.calls.length;

      await vi.advanceTimersByTimeAsync(5_000);
      expect(activation.renew).toHaveBeenCalledTimes(callsAtFinish);
      expect(activation.release).toHaveBeenCalledWith("lease_1");
    } finally {
      vi.useRealTimers();
    }
  });

  test("releases the lease even when the body throws", async () => {
    const activation = client();
    await expect(
      withRenewedLease({ client: activation, leaseId: "lease_1", renewIntervalMs: 60_000 }, () =>
        Promise.reject(new Error("boom")),
      ),
    ).rejects.toThrow("boom");
    expect(activation.release).toHaveBeenCalledWith("lease_1");
  });

  test("aborts the in-flight request when renewal is refused", async () => {
    // A lease the platform no longer honours means the executor may be reaped at
    // any moment. Failing fast turns that into a retry instead of a step running
    // on unprotected.
    vi.useFakeTimers();
    try {
      const activation = client({ renew: vi.fn(async () => false) });
      const onRenewFailure = vi.fn();

      const promise = withRenewedLease(
        {
          client: activation,
          leaseId: "lease_1",
          renewIntervalMs: 1_000,
          onRenewFailure,
        },
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      );
      // Attached before the timers run: the abort fires during the flush below,
      // so waiting until afterwards to assert would leave the rejection
      // momentarily unhandled and fail the run on a stray warning.
      const rejects = expect(promise).rejects.toThrow("aborted");

      await vi.advanceTimersByTimeAsync(1_100);
      await rejects;
      expect(onRenewFailure).toHaveBeenCalledWith("lease_1");
      expect(activation.release).toHaveBeenCalledWith("lease_1");
    } finally {
      vi.useRealTimers();
    }
  });
});
