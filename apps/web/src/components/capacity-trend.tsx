"use client"

import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import {
  capacityTimelineScale,
  formatCapacityTimelineTick,
  formatCapacityTooltipTimestamp,
} from "@/lib/instance-health"

export function CapacityTrend({
  label,
  value,
  points,
  hours,
  detail,
}: {
  label: string
  value: string
  points: Array<{
    observedAt: string
    value: number
  }>
  hours: number
  detail?: string
}) {
  const chartData = points.map((point) => ({
    ...point,
    timestamp: Date.parse(point.observedAt),
  }))
  const timelineScale = capacityTimelineScale(
    points.map((point) => point.observedAt),
    hours,
  )
  const chartConfig = {
    value: {
      label,
      color: "var(--chart-1)",
    },
  } satisfies ChartConfig

  return (
    <figure className="flex min-w-0 flex-col gap-3 py-4">
      <figcaption className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium">{label}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Last {hours === 168 ? "7 days" : `${hours} hours`} · UTC
          </p>
        </div>
        <div className="text-right">
          <p className="text-lg font-semibold tabular-nums">{value}</p>
          {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
        </div>
      </figcaption>
      {points.length >= 2 && timelineScale ? (
        <ChartContainer
          config={chartConfig}
          className="h-44 w-full"
          initialDimension={{ width: 320, height: 176 }}
          aria-label={`${label} trend`}
        >
          <LineChart
            accessibilityLayer
            data={chartData}
            margin={{ top: 8, right: 8, bottom: 0, left: 8 }}
          >
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="timestamp"
              type="number"
              scale="time"
              domain={timelineScale.domain}
              ticks={timelineScale.ticks}
              axisLine={false}
              tickLine={false}
              tickMargin={8}
              minTickGap={28}
              interval="preserveStartEnd"
              tickFormatter={(timestamp: number) =>
                formatCapacityTimelineTick(new Date(timestamp).toISOString(), hours)
              }
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tickMargin={6}
              width={48}
              domain={[0, 100]}
              ticks={[0, 50, 100]}
              tickFormatter={formatPercentTick}
            />
            <ChartTooltip
              cursor={{ stroke: "var(--border)", strokeDasharray: "3 3" }}
              content={
                <ChartTooltipContent
                  indicator="line"
                  labelFormatter={(_label, payload) => {
                    const observedAt = payload[0]?.payload?.observedAt
                    return observedAt ? formatCapacityTooltipTimestamp(observedAt) : ""
                  }}
                  formatter={(metricValue) => (
                    <>
                      <span className="text-muted-foreground">{label}</span>
                      <span className="ml-auto font-mono font-medium tabular-nums">
                        {Number(metricValue).toLocaleString()}%
                      </span>
                    </>
                  )}
                />
              }
            />
            <Line
              dataKey="value"
              type="monotone"
              stroke="var(--color-value)"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ChartContainer>
      ) : (
        <div className="flex h-16 items-center text-xs text-muted-foreground">
          Waiting for more samples
        </div>
      )}
    </figure>
  )
}

function formatPercentTick(value: number): string {
  return `${value}%`
}
