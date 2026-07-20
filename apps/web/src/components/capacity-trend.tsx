"use client"

import { Line, LineChart, XAxis, YAxis } from "recharts"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"

export function CapacityTrend({
  label,
  value,
  values,
  hours,
  detail,
}: {
  label: string
  value: string
  values: number[]
  hours: number
  detail?: string
}) {
  const chartData = values.map((metric, index) => ({
    sample: index + 1,
    metric,
  }))
  const chartConfig = {
    metric: {
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
            Last {hours === 168 ? "7 days" : `${hours} hours`}
          </p>
        </div>
        <div className="text-right">
          <p className="text-lg font-semibold tabular-nums">{value}</p>
          {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
        </div>
      </figcaption>
      {chartData.length >= 2 ? (
        <ChartContainer
          config={chartConfig}
          className="h-16 w-full"
          initialDimension={{ width: 240, height: 64 }}
          aria-label={`${label} trend`}
        >
          <LineChart
            accessibilityLayer
            data={chartData}
            margin={{ top: 4, right: 4, bottom: 4, left: 4 }}
          >
            <XAxis dataKey="sample" hide />
            <YAxis hide domain={["dataMin", "dataMax"]} />
            <ChartTooltip
              cursor={false}
              content={<ChartTooltipContent hideLabel indicator="line" />}
            />
            <Line
              dataKey="metric"
              type="monotone"
              stroke="var(--color-metric)"
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
