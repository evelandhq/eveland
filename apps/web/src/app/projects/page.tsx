import Link from 'next/link';
import { AlertTriangleIcon, ArrowUpRightIcon, FolderPlusIcon, PlusIcon } from 'lucide-react';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { getCollectorHealth, getProjects } from '@/lib/server-api';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function ProjectsPage() {
  const [projects, collector] = await Promise.all([getProjects(), getCollectorHealth()]);

  return (
    <div className="min-h-[calc(100svh-3rem)] bg-background">
      <section className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-5 py-6 md:px-8">
        {collector.status !== 'healthy' ? (
          <Alert>
            <AlertTriangleIcon />
            <AlertTitle>Session collector {collector.status}</AlertTitle>
            <AlertDescription>
              {collector.backlogEvents} queued events · {collector.backlogBytes} bytes · oldest{' '}
              {collector.oldestEventAge} ms · {collector.quarantinedEvents} quarantined
              {collector.lastError ? ` · ${collector.lastError}` : ''}
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-normal">Projects</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Imported eve agents, deployments, schedules, and recent runtime state.
            </p>
          </div>
          <div className="flex w-full items-center justify-between gap-3 sm:w-auto">
            <span className="text-xs text-muted-foreground">{projects.length} total</span>
            <Link
              href="/projects/new"
              className={cn(buttonVariants({ variant: 'link' }), 'text-foreground')}
            >
              <PlusIcon data-icon="inline-start" />
              New project
            </Link>
          </div>
        </div>

        {projects.length === 0 ? (
          <div className="flex min-h-80 rounded-md border bg-card">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FolderPlusIcon />
                </EmptyMedia>
                <EmptyTitle>No projects yet</EmptyTitle>
                <EmptyDescription>
                  Import a Git repository or Zip source to create the first deployment.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Link href="/projects/new" className={buttonVariants()}>
                  <PlusIcon data-icon="inline-start" />
                  New project
                </Link>
              </EmptyContent>
            </Empty>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {projects.map((project) => (
              <Card key={project.id} size="sm" className="h-full">
                <CardHeader>
                  <CardTitle>
                    <Link href={`/projects/${project.id}`} className="hover:underline">
                      {project.name}
                    </Link>
                  </CardTitle>
                  <CardDescription className="truncate">
                    {project.gitUrl ?? `${project.importKind.toUpperCase()} import`}
                  </CardDescription>
                  <CardAction>
                    <StatusBadge status={project.deploymentStatus} />
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-2 gap-4">
                    <div>
                      <dt className="text-xs text-muted-foreground">Latest session</dt>
                      <dd className="mt-2">
                        <StatusBadge status={project.latestSessionStatus} />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Next schedule</dt>
                      <dd className="mt-2 truncate text-xs font-medium">
                        {project.nextScheduleAt ?? 'None'}
                      </dd>
                    </div>
                  </dl>
                </CardContent>
                <CardFooter className="justify-between border-t">
                  <span className="text-xs text-muted-foreground">
                    Updated {new Date(project.updatedAt).toLocaleString()}
                  </span>

                  <Link
                    href={`/projects/${project.id}`}
                    aria-label={`Open ${project.name}`}
                    className={cn(
                      buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
                      'text-foreground',
                    )}
                  >
                    <ArrowUpRightIcon />
                  </Link>
                </CardFooter>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
