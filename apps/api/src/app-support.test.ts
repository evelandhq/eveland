import { describe, expect, test, vi } from "vitest";
import { projectPlaygroundStreamLine, type PlaygroundStreamStore } from "./app-support.js";

function recordingStore() {
  const completeSession = vi.fn<PlaygroundStreamStore["completeSession"]>(async () => null);
  return { store: { completeSession } as PlaygroundStreamStore, completeSession };
}

function commitLine(...facts: Array<Record<string, unknown>>): string {
  return JSON.stringify({ at: "2026-11-02T00:00:00.000Z", facts });
}

describe("projectPlaygroundStreamLine", () => {
  test("takes an approval-parked session back to running once its answer settles", async () => {
    // An answered interaction resumes the same turn with no new
    // `turn.started`, so `interaction.settled` is the only signal it runs again.
    const { store, completeSession } = recordingStore();
    const line = commitLine({
      type: "interaction.settled",
      scope: { turnId: "turn_1" },
      data: { interactionId: "int_1", outcome: "answered" },
    });

    await expect(
      projectPlaygroundStreamLine(line, "waiting_approval", store, "sess_1", "eve_1"),
    ).resolves.toBe("running");
    expect(completeSession).toHaveBeenCalledWith("sess_1", {
      status: "running",
      eveSessionId: "eve_1",
    });
  });

  test("projects the same boundaries as the observed Session", async () => {
    const { store } = recordingStore();
    const project = (
      type: string,
      current: Parameters<typeof projectPlaygroundStreamLine>[1],
      data: Record<string, unknown> = {},
    ) => projectPlaygroundStreamLine(commitLine({ type, data }), current, store, "s", "e");

    await expect(project("turn.started", "waiting")).resolves.toBe("running");
    await expect(project("interaction.opened", "running")).resolves.toBe("waiting_approval");
    await expect(project("turn.settled", "running", { outcome: "completed" })).resolves.toBe(
      "waiting",
    );
    await expect(project("session.ended", "running", { outcome: "completed" })).resolves.toBe(
      "completed",
    );
    await expect(project("model.completed", "running")).resolves.toBe("running");
  });

  test("parks a paused turn again when it still waits on a person", async () => {
    // Answering one of several open interactions settles only that one, and
    // eve pauses the same turn again while the others stay open.
    const { store, completeSession } = recordingStore();
    const line = commitLine({
      type: "turn.paused",
      scope: { turnId: "turn_1" },
      data: { turnId: "turn_1", interactionIds: ["int_2"] },
    });

    await expect(
      projectPlaygroundStreamLine(line, "running", store, "sess_1", "eve_1"),
    ).resolves.toBe("waiting_approval");
    expect(completeSession).toHaveBeenCalledWith("sess_1", {
      status: "waiting_approval",
      eveSessionId: "eve_1",
    });
  });
});

describe("projectPlaygroundStreamLine on commit lines", () => {
  test("folds every fact of a commit line in order", async () => {
    const { store, completeSession } = recordingStore();
    const line = JSON.stringify({
      at: "2026-11-02T00:00:00.000Z",
      facts: [
        { type: "delivery.consumed", scope: { turnId: "t1" }, data: { turnId: "t1" } },
        { type: "turn.started", scope: { turnId: "t1" }, data: { turnId: "t1" } },
        {
          type: "interaction.opened",
          scope: { turnId: "t1" },
          data: { interactionId: "i1", request: { kind: "approval", prompt: "ok?" } },
        },
      ],
    });

    await expect(
      projectPlaygroundStreamLine(line, "waiting", store, "sess_1", "eve_1"),
    ).resolves.toBe("waiting_approval");
    expect(completeSession).toHaveBeenCalledTimes(1);
    expect(completeSession).toHaveBeenCalledWith("sess_1", {
      status: "waiting_approval",
      eveSessionId: "eve_1",
    });
  });

  test("records the nested error when the session ends failed", async () => {
    const { store, completeSession } = recordingStore();
    const line = JSON.stringify({
      at: "2026-11-02T00:00:00.000Z",
      facts: [
        {
          type: "session.ended",
          data: { outcome: "failed", error: { code: "X", message: "model exploded" } },
        },
      ],
    });

    await expect(
      projectPlaygroundStreamLine(line, "running", store, "sess_1", "eve_1"),
    ).resolves.toBe("failed");
    expect(completeSession).toHaveBeenCalledWith("sess_1", {
      status: "failed",
      eveSessionId: "eve_1",
      error: "model exploded",
    });
  });

  test("ignores progress and transport records", async () => {
    const { store, completeSession } = recordingStore();
    for (const line of [
      JSON.stringify({ progress: { type: "content.delta", data: { partId: "p", delta: "x" } } }),
      JSON.stringify({ $eve: "heartbeat" }),
      JSON.stringify({ $eve: "position", next: 4 }),
    ]) {
      await expect(
        projectPlaygroundStreamLine(line, "running", store, "sess_1", "eve_1"),
      ).resolves.toBe("running");
    }
    expect(completeSession).not.toHaveBeenCalled();
  });
});
