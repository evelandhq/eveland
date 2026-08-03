import { describe, expect, test } from "vitest";
import { checkDispatchVersion, DISPATCH_VERSION, secretMatches } from "./dispatch-contract.js";

describe("dispatch contract", () => {
  test("accepts the current version", () => {
    expect(checkDispatchVersion(String(DISPATCH_VERSION))).toBeUndefined();
  });

  test("accepts an older dispatcher", () => {
    // Deployments outlive dispatcher releases; a newer bundle must keep serving
    // an older dispatcher for the whole run-out.
    expect(checkDispatchVersion("1", 2)).toBeUndefined();
  });

  test("rejects a newer dispatcher with an actionable error", () => {
    const rejection = checkDispatchVersion("2", 1);
    expect(rejection?.status).toBe(400);
    expect(rejection?.error).toContain("Rebuild the deployment");
  });

  test("accepts a request with no version header", () => {
    // Embedded mode POSTs to the same route over loopback carrying none of the
    // Eveland headers; requiring the header would break it.
    expect(checkDispatchVersion(null)).toBeUndefined();
    expect(checkDispatchVersion(undefined)).toBeUndefined();
    expect(checkDispatchVersion("")).toBeUndefined();
  });

  test("rejects a malformed version rather than coercing it", () => {
    for (const value of ["abc", "0", "-1", "1.5"]) {
      expect(checkDispatchVersion(value)?.status, value).toBe(400);
    }
  });

  test("secret comparison rejects mismatches and missing values", () => {
    expect(secretMatches("s3cret", "s3cret")).toBe(true);
    expect(secretMatches("s3cret", "s3creT")).toBe(false);
    expect(secretMatches("s3cret", "")).toBe(false);
    expect(secretMatches("s3cret", null)).toBe(false);
    expect(secretMatches("s3cret", undefined)).toBe(false);
    expect(secretMatches("s3cret", "s3cret-longer")).toBe(false);
  });
});
