"use client"

import type { UsageSeriesPoint } from "@eveland/core/contracts"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"

const chartConfig = {
  sessions: {
    label: "Sessions",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig

export function ProjectOverviewTrend({
  series,
}: {
  series: UsageSeriesPoint[]
}) {
  return (
    <ChartContainer config={chartConfig} className="h-56 w-full">
      <AreaChart
        accessibilityLayer
        data={series}
        margin={{ left: 4, right: 12 }}
      >
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="bucketStart"
          axisLine={false}
          tickLine={false}
          tickMargin={10}
          minTickGap={24}
          tickFormatter={(value: string) =>
            new Date(value).toLocaleDateString([], {
              month: "short",
              day: "numeric",
            })
          }
        />
        <YAxis
          axisLine={false}
          tickLine={false}
          tickMargin={8}
          width={40}
          allowDecimals={false}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_label, payload) => {
                const bucketStart = payload[0]?.payload?.bucketStart
                return bucketStart
                  ? new Date(bucketStart).toLocaleDateString()
                  : ""
              }}
            />
          }
        />
        <Area
          dataKey="sessions"
          type="monotone"
          fill="var(--color-sessions)"
          fillOpacity={0.12}
          stroke="var(--color-sessions)"
          strokeWidth={2}
        />
      </AreaChart>
    </ChartContainer>
  )
}
