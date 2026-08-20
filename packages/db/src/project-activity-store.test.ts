import { describe, expect, test } from "vitest";
import { createTestStore } from "./vitest-store.js";

/**
 * `listProjectActivity` rolls thirty days of sessions into one row per project
 * for the projects list. The parts worth pinning are the ones a query cannot
 * express and JS therefore has to get right: which UTC day a session lands in,
 * what a day reports when its sessions disagree, and which sessions count
 * toward the rate.
 *
 * Sessions are always created "now", and the window is moved by passing `now`
 * instead — the store offers no way to backdate a session, and pretending
 * otherwise by writing rows behind its back would test a different thing.
 */
async function projectWithSessions(
  store: ReturnType<typeof createTestStore>,
  name: string,
  statuses: ReadonlyArray<"completed" | "failed" | "waiting_approval">,
) {
  const project = await store.createProject({ name, importKind: "git", gitUrl: null });
  for (const status of statuses) {
    const session = await store.createSession({ projectId: project.id, trigger: "api" });
    if (status !== "waiting_approval") {
      await store.completeSession(session.id, { status });
    } else {
      await store.completeSession(session.id, { status: "waiting_approval" });
    }
  }
  return project;
}

describe("listProjectActivity", () => {
  test("reports the worst outcome of a day, not the last one", async () => {
    const store = createTestStore();
    const project = await projectWithSessions(store, "worst-wins", [
      "completed",
      "failed",
      "completed",
    ]);

    const [activity] = await store.listProjectActivity({ days: 30 });

    expect(activity?.projectId).toBe(project.id);
    expect(activity?.days).toHaveLength(30);
    // Today is the last cell, and one failure is enough to colour it.
    expect(activity?.days.at(-1)).toBe("failed");
    expect(activity?.sessions).toBe(3);
    expect(activity?.failed).toBe(1);
    expect(activity?.succeeded).toBe(2);
  });

  test("ranks awaiting below failed but above ok", async () => {
    const store = createTestStore();
    await projectWithSessions(store, "awaiting", ["completed", "waiting_approval"]);

    const [activity] = await store.listProjectActivity({ days: 30 });

    expect(activity?.days.at(-1)).toBe("attention");
    expect(activity?.awaiting).toBe(1);
  });

  test("leaves days without sessions empty rather than assuming success", async () => {
    const store = createTestStore();
    await projectWithSessions(store, "sparse", ["completed"]);

    const [activity] = await store.listProjectActivity({ days: 30 });

    expect(activity?.days.at(-1)).toBe("ok");
    expect(activity?.days.slice(0, 29).every((day) => day === "none")).toBe(true);
  });

  test("buckets by UTC day relative to the caller's reference time", async () => {
    const store = createTestStore();
    await projectWithSessions(store, "shifted", ["completed"]);

    // Three days on, the same session should have slid three cells to the left.
    const later = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const [activity] = await store.listProjectActivity({ days: 30, now: later });

    expect(activity?.days.at(-1)).toBe("none");
    expect(activity?.days.at(-4)).toBe("ok");
  });

  test("drops sessions that fall out of the window", async () => {
    const store = createTestStore();
    await projectWithSessions(store, "expired", ["completed", "failed"]);

    const wayLater = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
    const [activity] = await store.listProjectActivity({ days: 30, now: wayLater });

    expect(activity).toBeUndefined();
  });

  test("rates only settled sessions, and reports null when none have settled", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "unsettled",
      importKind: "git",
      gitUrl: null,
    });
    await store.createSession({ projectId: project.id, trigger: "api" });

    const [activity] = await store.listProjectActivity({ days: 30 });

    expect(activity?.sessions).toBe(1);
    expect(activity?.successRate).toBeNull();
    expect(activity?.p95DurationMs).toBeNull();
  });
});
