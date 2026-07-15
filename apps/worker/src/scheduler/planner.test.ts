import type { Store } from "@eveland/db";
import { describe, expect, test, vi } from "vitest";
import { planDueSchedules } from "./planner.js";

describe("planDueSchedules", () => {
  test("uses the durable bounded Store claim as the complete planning transaction", async () => {
    const claimDueScheduleRuns = vi.fn().mockResolvedValue([{ id: "srun_one" }, { id: "srun_two" }]);
    const now = new Date("2026-07-15T03:04:05.000Z");

    await expect(planDueSchedules({ claimDueScheduleRuns } as unknown as Store, { now, limit: 25 })).resolves.toBe(2);
    expect(claimDueScheduleRuns).toHaveBeenCalledWith({ now, limit: 25 });
  });
});
