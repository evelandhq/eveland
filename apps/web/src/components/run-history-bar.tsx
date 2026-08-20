import type { ProjectActivityDay } from "@evelandhq/core/contracts";
import { cn } from "@/lib/utils";

const DAY_FILL: Record<ProjectActivityDay, string> = {
  ok: "bg-success",
  attention: "bg-warning",
  failed: "bg-destructive",
  none: "bg-neutral-subtle",
};

const DAY_LABEL: Record<ProjectActivityDay, string> = {
  ok: "ran clean",
  attention: "waited on a human",
  failed: "had a failed session",
  none: "did not run",
};

function dayTitle(day: ProjectActivityDay, daysAgo: number): string {
  const when = daysAgo === 0 ? "Today" : daysAgo === 1 ? "Yesterday" : `${daysAgo} days ago`;
  return `${when} — ${DAY_LABEL[day]}`;
}

/**
 * One cell per day, oldest first. Reads as a run record rather than a chart:
 * the point is which days were clean, not how many sessions ran.
 */
export function RunHistoryBar({
  days,
  className,
}: {
  days: ProjectActivityDay[];
  className?: string;
}) {
  const clean = days.filter((day) => day === "ok").length;
  const trouble = days.filter((day) => day === "failed" || day === "attention").length;

  return (
    <div
      aria-label={`Last ${days.length} days: ${clean} clean, ${trouble} needing attention`}
      className={cn("flex h-2.5 w-full items-stretch gap-px", className)}
      role="img"
    >
      {days.map((day, index) => (
        <span
          className={cn("flex-1 rounded-[1px] first:rounded-l-sm last:rounded-r-sm", DAY_FILL[day])}
          // Days are positional, so the index is the identity here.
          key={index}
          title={dayTitle(day, days.length - 1 - index)}
        />
      ))}
    </div>
  );
}
