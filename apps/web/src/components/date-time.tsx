"use client";

import { useDisplayTimezone } from "@/components/time-zone-provider";
import { formatDate, formatDateTime, formatTime } from "@/lib/date-time";

type DateTimeValue = string | number | Date;

export function DateTime({
  value,
  display = "date-time",
  options,
  className,
}: {
  value: DateTimeValue;
  display?: "date-time" | "date" | "time";
  options?: Intl.DateTimeFormatOptions;
  className?: string;
}) {
  const timeZone = useDisplayTimezone();
  const date = value instanceof Date ? value : new Date(value);
  const dateTime = Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
  const formatted = timeZone
    ? display === "date"
      ? formatDate(value, timeZone, options)
      : display === "time"
        ? formatTime(value, timeZone, options)
        : formatDateTime(value, timeZone, options)
    : String(value);
  const title =
    timeZone && !Number.isNaN(date.getTime())
      ? formatDateTime(value, timeZone, { timeZoneName: "short" })
      : String(value);

  return (
    <time className={className} dateTime={dateTime} title={title} suppressHydrationWarning>
      {formatted}
    </time>
  );
}
