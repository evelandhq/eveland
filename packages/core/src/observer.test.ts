import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createEventFingerprint, observerEnvelopeV1Schema, shouldCollectObserverEvent } from "./observer.js";

describe("observer envelope V1", () => {
  test("exports a versioned validator and stable semantic fingerprint", async () => {
    const observerPath = path.resolve(import.meta.dirname, "observer.ts");
    const source = await readFile(observerPath, "utf8").catch(() => null);
    expect(source).not.toBeNull();
    if (source === null) return;

    const observer = (await import(observerPath)) as Record<string, unknown>;

    expect(observer).toMatchObject({
      observerEnvelopeV1Schema: expect.objectContaining({ safeParse: expect.any(Function) }),
      createEventFingerprint: expect.any(Function),
      shouldCollectObserverEvent: expect.any(Function),
    });
  });

  test("fingerprint ignores object key order but preserves semantic changes", () => {
    const first = createEventFingerprint("eve_1", "2026-07-13T00:00:00.000Z", { type: "step.completed", data: { b: 2, a: 1 } });
    const reordered = createEventFingerprint("eve_1", "2026-07-13T00:00:00.000Z", {
      data: { a: 1, b: 2 },
      type: "step.completed",
    });

    expect(reordered).toBe(first);
    expect(createEventFingerprint("eve_1", "2026-07-13T00:00:00.000Z", { type: "step.failed" })).not.toBe(first);
  });

  test("filters deltas and reasoning content by default", () => {
    expect(shouldCollectObserverEvent("message.completed")).toBe(true);
    expect(shouldCollectObserverEvent("turn.cancelled")).toBe(true);
    expect(shouldCollectObserverEvent("message.appended")).toBe(false);
    expect(shouldCollectObserverEvent("reasoning.appended", true)).toBe(false);
    expect(shouldCollectObserverEvent("reasoning.completed")).toBe(false);
    expect(shouldCollectObserverEvent("reasoning.completed", true)).toBe(true);
  });

  test("rejects an envelope without a trusted deployment identity", () => {
    expect(
      observerEnvelopeV1Schema.safeParse({
        schemaVersion: 1,
        observerEventId: "evt_1",
        eventFingerprint: "fingerprint",
        deploymentId: "",
        eveSessionId: "eve_1",
        parentEveSessionId: null,
        sourceSequence: 1,
        agent: { id: null, name: null, nodeId: null },
        channelKind: "http",
        eventAt: "2026-07-13T00:00:00.000Z",
        event: { type: "session.started" },
      }).success,
    ).toBe(false);
  });
});
