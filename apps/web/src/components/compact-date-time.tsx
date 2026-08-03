"use client";

import { useDisplayTimezone } from "@/components/time-zone-provider";
import { formatCompactDateTime, formatDateTime } from "@/lib/date-time";

export function CompactDateTime({ value }: { value: string }) {
  const timeZone = useDisplayTimezone();
  const date = new Date(value);
  const label = timeZone ? formatCompactDateTime(value, new Date(), timeZone) : "—";
  const title =
    Number.isNaN(date.getTime()) || !timeZone
      ? value
      : formatDateTime(value, timeZone, { timeZoneName: "short" });

  return (
    <time dateTime={value} title={title} suppressHydrationWarning>
      {label}
    </time>
  );
}
