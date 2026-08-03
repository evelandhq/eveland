import { describe, expect, test } from "vitest";
import { assertValidTenantId, derivePartitionName, tenantStreamChannel } from "./tenant.js";

describe("tenant identifiers", () => {
  test("partition names stay inside Postgres' 63-byte identifier limit", () => {
    const longest = "p_".padEnd(128, "x");
    assertValidTenantId(longest);
    const name = derivePartitionName("workflow_stream_chunks", longest);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  test("case-variant ids do not collide", () => {
    // Postgres folds unquoted identifiers to lowercase, so two project ids that
    // differ only in case would otherwise derive the same partition.
    const lower = derivePartitionName("workflow_events", "p_alpha");
    const upper = derivePartitionName("workflow_events", "p_ALPHA");
    expect(lower).not.toEqual(upper);
  });

  test("partition names are deterministic", () => {
    expect(derivePartitionName("workflow_events", "p_alpha")).toEqual(
      derivePartitionName("workflow_events", "p_alpha"),
    );
  });

  test("different tables for one tenant get different partitions", () => {
    expect(derivePartitionName("workflow_events", "p_alpha")).not.toEqual(
      derivePartitionName("workflow_stream_chunks", "p_alpha"),
    );
  });

  test("stream channels are per tenant", () => {
    // A shared channel would wake every agent on the platform for every chunk.
    expect(tenantStreamChannel("p_alpha")).not.toEqual(tenantStreamChannel("p_beta"));
  });

  test("rejects ids that could not survive an identifier round trip", () => {
    for (const invalid of ["", "p alpha", "p'alpha", 'p"alpha', "p;drop", "p.alpha", "é"]) {
      expect(() => assertValidTenantId(invalid), invalid).toThrow();
    }
    expect(() => assertValidTenantId("x".repeat(129))).toThrow();
  });

  test("accepts the id shapes the platform actually mints", () => {
    for (const valid of ["p_alpha", "proj-123", "P_9", "a"]) {
      expect(() => assertValidTenantId(valid), valid).not.toThrow();
    }
  });
});
