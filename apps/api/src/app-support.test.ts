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
});
