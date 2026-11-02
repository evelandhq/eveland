import { describe, expect, test, vi } from "vitest";
import { projectPlaygroundStreamLine, type PlaygroundStreamStore } from "./app-support.js";

function recordingStore() {
  const completeSession = vi.fn<PlaygroundStreamStore["completeSession"]>(async () => null);
  return { store: { completeSession } as PlaygroundStreamStore, completeSession };
}

describe("projectPlaygroundStreamLine", () => {
  test("takes an approval-parked session back to running once its answer is accepted", async () => {
    // eve 0.69+ resumes an answered turn under the same turnId, with no new
    // `turn.started`, so `input.resolved` is the only signal it runs again.
    const { store, completeSession } = recordingStore();
    const line = JSON.stringify({
      type: "input.resolved",
      data: { turnId: "turn_1", resolutions: [{ requestId: "req_1", outcome: "approved" }] },
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
    const project = (type: string, current: Parameters<typeof projectPlaygroundStreamLine>[1]) =>
      projectPlaygroundStreamLine(JSON.stringify({ type, data: {} }), current, store, "s", "e");

    await expect(project("turn.started", "waiting")).resolves.toBe("running");
    await expect(project("input.requested", "running")).resolves.toBe("waiting_approval");
    await expect(project("session.waiting", "waiting_approval")).resolves.toBe("waiting_approval");
    await expect(project("session.waiting", "running")).resolves.toBe("waiting");
    await expect(project("session.completed", "running")).resolves.toBe("completed");
    await expect(project("step.completed", "running")).resolves.toBe("running");
  });

  test("parks a held turn again when it still waits on a person", async () => {
    // A partial answer resolves one request, then eve re-parks the same turn
    // with `turn.waiting { on: "input" }` while the others stay open.
    const { store, completeSession } = recordingStore();
    const line = JSON.stringify({
      type: "turn.waiting",
      data: { on: "input", sequence: 7, turnId: "turn_1" },
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

describe("projectPlaygroundStreamLine on a v27 stream", () => {
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

  test("records the nested v27 error when the session ends failed", async () => {
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
