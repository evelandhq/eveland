"use client";

import { useEffect, useState } from "react";
import { formatCompactDateTime } from "@/lib/date-time";

export function CompactDateTime({
  value,
  fallback,
}: {
  value: string;
  fallback: string;
}) {
  const [label, setLabel] = useState(fallback);
  const [title, setTitle] = useState(value);

  useEffect(() => {
    const date = new Date(value);
    setLabel(formatCompactDateTime(value, new Date()));
    setTitle(Number.isNaN(date.getTime()) ? value : date.toLocaleString());
  }, [value]);

  return (
    <time dateTime={value} title={title}>
      {label}
    </time>
  );
}
