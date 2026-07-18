import type { ReactNode } from "react";
import { trendPoints } from "@/lib/instance-health";

export function CapacityTrend({
  label,
  value,
  values,
  hours,
  detail,
}: {
  label: string;
  value: string;
  values: number[];
  hours: number;
  detail?: ReactNode;
}) {
  const points = trendPoints(values, 240, 64);
  return (
    <figure className="flex min-w-0 flex-col gap-3 py-4">
      <figcaption className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium">{label}</p>
          <p className="mt-1 text-xs text-muted-foreground">Last {hours === 168 ? "7 days" : `${hours} hours`}</p>
        </div>
        <div className="text-right">
          <p className="text-lg font-semibold tabular-nums">{value}</p>
          {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
        </div>
      </figcaption>
      {points ? (
        <svg viewBox="0 0 240 64" role="img" aria-label={`${label} trend`} className="h-16 w-full overflow-visible text-foreground">
          <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        </svg>
      ) : (
        <div className="flex h-16 items-center text-xs text-muted-foreground">Waiting for more samples</div>
      )}
    </figure>
  );
}
