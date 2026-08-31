// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ runSchedule: vi.fn() }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client-api", () => api);
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { RunScheduleAction } from "./run-schedule-action";
import { Toaster } from "@/components/ui/toast";

import type { ScheduleRunStatus } from "@/lib/api";

function renderAction(latestRunStatus: ScheduleRunStatus | null = null) {
  return render(
    <>
      <RunScheduleAction
        projectId="proj_1"
        scheduleId="sched_1"
        scheduleKey="weekly-report"
        latestRunStatus={latestRunStatus}
        disabled={false}
      />
      <Toaster />
    </>,
  );
}

describe("RunScheduleAction", () => {
  beforeEach(() => {
    api.runSchedule.mockReset();
    refresh.mockClear();
  });

  test("a queued run is confirmed with a toast, not a silent refresh", async () => {
    api.runSchedule.mockResolvedValue(undefined);
    renderAction();

    fireEvent.click(screen.getByRole("button", { name: /run now/i }));

    await screen.findByText("Run queued");
    expect(screen.getByText(/weekly-report/)).toBeDefined();
    expect(api.runSchedule).toHaveBeenCalledExactlyOnceWith("proj_1", "sched_1");
    expect(refresh).toHaveBeenCalled();
  });

  test("re-clicking while the request is in flight queues no second run", async () => {
    let release: () => void = () => {};
    api.runSchedule.mockReturnValue(
      new Promise<void>((resolvePromise) => {
        release = resolvePromise;
      }),
    );
    renderAction();

    const button = screen.getByRole("button", { name: /run now/i });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(api.runSchedule).toHaveBeenCalledTimes(1);

    release();
    await screen.findByText("Run queued");
  });

  test("a terminal latest run queues immediately without a confirmation", async () => {
    api.runSchedule.mockResolvedValue(undefined);
    renderAction("succeeded");

    fireEvent.click(screen.getByRole("button", { name: /run now/i }));

    await screen.findByText("Run queued");
    expect(api.runSchedule).toHaveBeenCalledExactlyOnceWith("proj_1", "sched_1");
  });

  test("an ambiguous latest dispatch requires confirmation before queueing", async () => {
    api.runSchedule.mockResolvedValue(undefined);
    renderAction("dispatch_unknown");

    fireEvent.click(screen.getByRole("button", { name: /run now/i }));

    // Nothing is queued yet: the click only opens the warning.
    expect(api.runSchedule).not.toHaveBeenCalled();
    await screen.findByText("Queue another run?");
    expect(screen.getByText(/may still execute/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /queue anyway/i }));

    await screen.findByText("Run queued");
    expect(api.runSchedule).toHaveBeenCalledExactlyOnceWith("proj_1", "sched_1");
  });

  test("cancelling the ambiguous-dispatch confirmation queues nothing", async () => {
    renderAction("dispatch_unknown");

    fireEvent.click(screen.getByRole("button", { name: /run now/i }));
    await screen.findByText("Queue another run?");

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByText("Queue another run?")).toBeNull());
    expect(api.runSchedule).not.toHaveBeenCalled();
  });

  test("a rejected queue surfaces the error inline without a toast", async () => {
    api.runSchedule.mockRejectedValue(new Error("Deployment is not running."));
    renderAction();

    fireEvent.click(screen.getByRole("button", { name: /run now/i }));

    await screen.findByText("Deployment is not running.");
    await waitFor(() => expect(screen.queryByText("Run queued")).toBeNull());
  });
});
