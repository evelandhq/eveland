import type { Store } from "@eveland/db";

export async function planDueSchedules(
  store: Store,
  input: { now?: Date; limit?: number } = {},
): Promise<number> {
  const limit = input.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Scheduler planner batch size must be between 1 and 100.");
  }
  const runs = await store.claimDueScheduleRuns({ now: input.now ?? new Date(), limit });
  return runs.length;
}
