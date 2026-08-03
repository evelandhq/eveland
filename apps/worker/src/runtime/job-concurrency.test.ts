import { describe, expect, test } from "vitest";
import { deriveMaxConcurrentHeavyJobs, resolveMaxConcurrentHeavyJobs } from "./job-concurrency.js";

const GIB = 1024 ** 3;

function machine(totalGib: number, cpuCoreCount: number) {
  return { totalMemoryBytes: totalGib * GIB, cpuCoreCount };
}

describe("deriveMaxConcurrentHeavyJobs", () => {
  test.each([
    // Mirrors the reference table in docs/deploy/linux.md "Capacity planning".
    { totalGib: 4, cores: 4, expected: 1 },
    { totalGib: 8, cores: 4, expected: 2 },
    { totalGib: 16, cores: 8, expected: 4 },
    { totalGib: 32, cores: 12, expected: 8 },
  ])("$totalGib GiB / $cores cores derives $expected", ({ totalGib, cores, expected }) => {
    expect(deriveMaxConcurrentHeavyJobs(machine(totalGib, cores))).toBe(expected);
  });

  test("never derives below one build, even on a tiny host", () => {
    expect(deriveMaxConcurrentHeavyJobs(machine(2, 1))).toBe(1);
  });

  test("is CPU-bound when memory is plentiful but cores are few", () => {
    expect(deriveMaxConcurrentHeavyJobs(machine(64, 4))).toBe(2);
  });

  test("is memory-bound when cores are plentiful but memory is scarce", () => {
    expect(deriveMaxConcurrentHeavyJobs(machine(8, 32))).toBe(2);
  });
});

describe("resolveMaxConcurrentHeavyJobs", () => {
  test("EVELAND_MAX_CONCURRENT_JOBS overrides the machine-derived default", () => {
    expect(resolveMaxConcurrentHeavyJobs({ EVELAND_MAX_CONCURRENT_JOBS: "3" }, machine(4, 4))).toBe(
      3,
    );
  });

  test.each(["0", "-2", "abc", ""])(
    "invalid override %j falls back to the derived default",
    (override) => {
      expect(
        resolveMaxConcurrentHeavyJobs({ EVELAND_MAX_CONCURRENT_JOBS: override }, machine(8, 4)),
      ).toBe(2);
    },
  );

  test("an unset override uses the derived default", () => {
    expect(resolveMaxConcurrentHeavyJobs({}, machine(16, 8))).toBe(4);
  });
});
