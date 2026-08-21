"use client";

import type { UsageSeriesPoint } from "@evelandhq/core/contracts";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { useDisplayTimezone } from "@/components/time-zone-provider";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { formatDate } from "@/lib/date-time";

const chartConfig = {
  sessions: {
    label: "Sessions",
    // chart-1 is the single-series colour; 2-5 exist to separate multiple series.
    color: "var(--chart-1)",
  },
} satisfies ChartConfig;

export function ProjectOverviewTrend({ series }: { series: UsageSeriesPoint[] }) {
  const timeZone = useDisplayTimezone();

  return (
    <ChartContainer config={chartConfig} className="h-56 w-full">
      <AreaChart accessibilityLayer data={series} margin={{ left: 4, right: 12 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="bucketStart"
          axisLine={false}
          tickLine={false}
          tickMargin={10}
          minTickGap={24}
          tickFormatter={(value: string) =>
            formatDate(value, timeZone, {
              month: "short",
              day: "numeric",
              year: undefined,
            })
          }
        />
        <YAxis axisLine={false} tickLine={false} tickMargin={8} width={40} allowDecimals={false} />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_label, payload) => {
                const bucketStart = payload[0]?.payload?.bucketStart;
                return bucketStart ? formatDate(bucketStart, timeZone) : "";
              }}
            />
          }
        />
        <defs>
          <linearGradient id="fillSessions" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-sessions)" stopOpacity={0.22} />
            <stop offset="100%" stopColor="var(--color-sessions)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          dataKey="sessions"
          type="monotone"
          fill="url(#fillSessions)"
          stroke="var(--color-sessions)"
          strokeWidth={2}
        />
      </AreaChart>
    </ChartContainer>
  );
}
