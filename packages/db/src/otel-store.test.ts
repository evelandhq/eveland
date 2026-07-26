import { describe, expect, test } from "vitest";
import { createTestStore } from "./vitest-store.js";

describe("Built-in batch receipts", () => {
  test("reports a redelivered batch as a duplicate", async () => {
    const store = createTestStore();
    const payload = { resourceSpans: [{ scopeSpans: [] }] };

    const first = await store.ingestOtlpBatch({
      signal: "traces",
      payload,
    });
    expect(first).toMatchObject({ accepted: true, duplicate: false });

    const second = await store.ingestOtlpBatch({
      signal: "traces",
      payload,
    });
    expect(second).toMatchObject({
      id: first.id,
      accepted: true,
      duplicate: true,
    });
  });

  test("hashes payloads independently of key order", async () => {
    const store = createTestStore();
    await store.ingestOtlpBatch({
      signal: "logs",
      payload: { a: 1, b: 2 },
    });
    await expect(
      store.ingestOtlpBatch({ signal: "logs", payload: { b: 2, a: 1 } }),
    ).resolves.toMatchObject({ duplicate: true });
  });

  test("separates the same payload arriving on different signals", async () => {
    const store = createTestStore();
    const payload = { shared: true };
    await store.ingestOtlpBatch({ signal: "traces", payload });
    await expect(
      store.ingestOtlpBatch({ signal: "metrics", payload }),
    ).resolves.toMatchObject({ duplicate: false });
  });

  test("exposes the newest receipt time for Built-in status", async () => {
    const store = createTestStore();
    await expect(store.latestOtlpBatchReceivedAt()).resolves.toBeNull();
    await store.ingestOtlpBatch({ signal: "traces", payload: { n: 1 } });
    await expect(store.latestOtlpBatchReceivedAt()).resolves.toEqual(
      expect.any(String),
    );
  });
});

describe("Built-in retention", () => {
  test("prunes batch receipts on their own cutoff", async () => {
    const store = createTestStore();
    await store.ingestOtlpBatch({ signal: "traces", payload: { n: 1 } });

    await expect(
      store.pruneOtlpTelemetry({
        receiptsBefore: new Date("2020-01-01T00:00:00.000Z"),
      }),
    ).resolves.toEqual({ receipts: 0 });
    await expect(store.latestOtlpBatchReceivedAt()).resolves.toEqual(
      expect.any(String),
    );

    await expect(
      store.pruneOtlpTelemetry({ receiptsBefore: new Date() }),
    ).resolves.toEqual({ receipts: 1 });
    await expect(store.latestOtlpBatchReceivedAt()).resolves.toBeNull();
  });
});
