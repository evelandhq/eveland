"use client";

import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";

export function CapacityProgress({
  label,
  value,
  displayValue,
}: {
  label: string;
  value: number;
  displayValue: string;
}) {
  return (
    <Progress value={value}>
      <ProgressLabel>{label}</ProgressLabel>
      <ProgressValue>{() => displayValue}</ProgressValue>
    </Progress>
  );
}
