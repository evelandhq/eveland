import Link from "next/link"
import { ChartNoAxesColumnIcon, FolderIcon } from "lucide-react"
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
import { getProjects, getSessions } from "@/lib/api"
import { formatTokenCount, formatUsd, summarizeTokenUsage } from "@/lib/usage"

export const dynamic = "force-dynamic"

export default async function UsagePage() {
  const projects = await getProjects()
  const projectUsage = await Promise.all(
    projects.map(async (project) => {
      const sessions = await getSessions(project.id)
      return {
        project,
        sessions,
        usage: summarizeTokenUsage(sessions.map((session) => session.usage)),
      }
    }),
  )
  const totalUsage = summarizeTokenUsage(
    projectUsage.flatMap(({ sessions }) => sessions.map((session) => session.usage)),
  )

  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-5 py-6 md:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Usage</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Model token consumption and reported provider cost across every project.
          </p>
        </div>
        <dl className="flex items-center gap-6 text-right">
          <div>
            <dt className="text-xs text-muted-foreground">Total tokens</dt>
            <dd className="font-mono text-sm font-medium">
              {totalUsage.status === "none" || totalUsage.status === "missing" ? "—" : formatTokenCount(totalUsage.totalTokens)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Provider cost</dt>
            <dd className="font-mono text-sm font-medium">{formatUsd(totalUsage.costUsd)}</dd>
          </div>
        </dl>
      </div>

      {projects.length === 0 ? (
        <div className="flex min-h-80 rounded-md border bg-card">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ChartNoAxesColumnIcon />
              </EmptyMedia>
              <EmptyTitle>No usage yet</EmptyTitle>
              <EmptyDescription>
                Usage will appear after a project records its first model session.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" render={<Link href="/projects" />}>
                <FolderIcon data-icon="inline-start" />
                View projects
              </Button>
            </EmptyContent>
          </Empty>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Project</TableHead>
                <TableHead>Coverage</TableHead>
                <TableHead className="text-right">Sessions</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Input / output</TableHead>
                <TableHead className="text-right">Cache read / write</TableHead>
                <TableHead className="text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projectUsage.map(({ project, sessions, usage }) => (
                <TableRow key={project.id}>
                  <TableCell>
                    <Link href={`/projects/${project.id}/usage`} className="font-medium hover:underline">
                      {project.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant={usage.status === "reported" ? "default" : usage.status === "partial" ? "outline" : "secondary"}>
                      {usage.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono">{sessions.length}</TableCell>
                  <TableCell className="text-right font-mono font-medium">
                    {usage.status === "none" || usage.status === "missing" ? "—" : formatTokenCount(usage.totalTokens)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-muted-foreground">
                    {formatTokenCount(usage.inputTokens)} / {formatTokenCount(usage.outputTokens)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-muted-foreground">
                    {formatTokenCount(usage.cacheReadTokens)} / {formatTokenCount(usage.cacheWriteTokens)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-muted-foreground">{formatUsd(usage.costUsd)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  )
}
