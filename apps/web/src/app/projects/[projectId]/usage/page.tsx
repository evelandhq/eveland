import Link from "next/link"
import { ChartNoAxesColumnIcon, PlayIcon } from "lucide-react"
import { StatusBadge } from "@/components/status-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { getSessions } from "@/lib/api"
import { formatTokenCount, formatUsd, summarizeTokenUsage } from "@/lib/usage"

export const dynamic = "force-dynamic"

export default async function ProjectUsagePage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params
  const sessions = await getSessions(projectId)
  const usage = summarizeTokenUsage(sessions.map((session) => session.usage))

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Usage</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Token consumption and provider-reported cost for this project.
          </p>
        </div>
        <Badge variant={usage.status === "reported" ? "default" : usage.status === "partial" ? "outline" : "secondary"}>
          {usage.status}
        </Badge>
      </div>

      <dl className="grid overflow-hidden rounded-md border bg-card sm:grid-cols-2 lg:grid-cols-4">
        <div className="border-b p-4 sm:border-r lg:border-b-0">
          <dt className="text-xs text-muted-foreground">Total tokens</dt>
          <dd className="mt-2 font-mono text-lg font-semibold">
            {usage.status === "none" || usage.status === "missing" ? "—" : formatTokenCount(usage.totalTokens)}
          </dd>
        </div>
        <div className="border-b p-4 lg:border-r lg:border-b-0">
          <dt className="text-xs text-muted-foreground">Input / output</dt>
          <dd className="mt-2 font-mono text-lg font-semibold">
            {formatTokenCount(usage.inputTokens)} / {formatTokenCount(usage.outputTokens)}
          </dd>
        </div>
        <div className="border-b p-4 sm:border-r sm:border-b-0">
          <dt className="text-xs text-muted-foreground">Cache read / write</dt>
          <dd className="mt-2 font-mono text-lg font-semibold">
            {formatTokenCount(usage.cacheReadTokens)} / {formatTokenCount(usage.cacheWriteTokens)}
          </dd>
        </div>
        <div className="p-4">
          <dt className="text-xs text-muted-foreground">Provider cost</dt>
          <dd className="mt-2 font-mono text-lg font-semibold">{formatUsd(usage.costUsd)}</dd>
        </div>
      </dl>

      {sessions.length === 0 ? (
        <div className="flex min-h-72 rounded-md border bg-card">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ChartNoAxesColumnIcon />
              </EmptyMedia>
              <EmptyTitle>No usage recorded</EmptyTitle>
              <EmptyDescription>
                Run the agent in Playground or through an endpoint to begin collecting usage.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button render={<Link href={`/projects/${projectId}/playground`} />}>
                <PlayIcon data-icon="inline-start" />
                Open Playground
              </Button>
            </EmptyContent>
          </Empty>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Session</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Input / output</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead>Started</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((session) => {
                const sessionTokens = session.usage.inputTokens + session.usage.outputTokens

                return (
                  <TableRow key={session.id}>
                    <TableCell>
                      <Link
                        href={`/projects/${projectId}/sessions/${session.id}`}
                        className="font-mono font-medium hover:underline"
                      >
                        {session.id}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{session.trigger}</TableCell>
                    <TableCell>
                      <StatusBadge status={session.status} />
                    </TableCell>
                    <TableCell className="text-right font-mono font-medium">
                      {session.usage.status === "none" || session.usage.status === "missing" ? "—" : formatTokenCount(sessionTokens)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground">
                      {formatTokenCount(session.usage.inputTokens)} / {formatTokenCount(session.usage.outputTokens)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground">{formatUsd(session.usage.costUsd)}</TableCell>
                    <TableCell className="text-muted-foreground">{new Date(session.startedAt).toLocaleString()}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
