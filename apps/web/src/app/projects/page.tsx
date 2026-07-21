import Link from 'next/link';
import { SiGit, SiGithub, SiGitlab } from '@icons-pack/react-simple-icons';
import {
  AlertTriangleIcon,
  ArrowUpRightIcon,
  FolderArchiveIcon,
  FolderPlusIcon,
  PlusIcon,
} from 'lucide-react';
import { ProjectDeletionPoller } from '@/components/project-deletion-poller';
import { CompactDateTime } from '@/components/compact-date-time';
import { EveVersionCardStatus } from '@/components/eve-version-status';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
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
import { describeProjectSource } from '@/lib/project-source';
import { formatCompactDateTime } from '@/lib/date-time';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: "Projects",
};

const projectSourceIconByKind = {
  github: SiGithub,
  gitlab: SiGitlab,
  git: SiGit,
  zip: FolderArchiveIcon,
};

export default async function ProjectsPage() {
  const [projects, collector] = await Promise.all([getProjects(), getCollectorHealth()]);
  const renderedAt = new Date();

  return (
    <div className="min-h-[calc(100svh-3rem)] bg-background">
      <ProjectDeletionPoller active={projects.some((project) => project.deletionStatus === 'deleting')} />
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
              href="/new"
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
                <Link href="/new" className={buttonVariants()}>
                  <PlusIcon data-icon="inline-start" />
                  New project
                </Link>
              </EmptyContent>
            </Empty>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {projects.map((project) => {
              const deleting = project.deletionStatus === 'deleting';
              const projectStatus = project.deletionStatus === 'failed'
                ? 'delete_failed'
                : project.deploymentStatus;
              const source = describeProjectSource(project.importKind, project.gitUrl);
              const ProjectSourceIcon = projectSourceIconByKind[source.kind];
              return (
              <Card key={project.id} size="sm" className="h-full" aria-busy={deleting}>
                <CardHeader>
                  <CardTitle>
                    {deleting ? (
                      project.name
                    ) : (
                      <Link href={`/projects/${project.id}`} className="hover:underline">
                        {project.name}
                      </Link>
                    )}
                  </CardTitle>
                  <CardDescription className="flex min-w-0 items-center gap-1.5">
                    <ProjectSourceIcon aria-hidden="true" className="size-3.5 shrink-0" />
                    <span className="truncate" title={project.gitUrl ?? source.label}>
                      {source.label}
                    </span>
                  </CardDescription>
                  <CardAction>
                    {deleting ? (
                      <Badge variant="secondary">
                        <Spinner />
                        Deleting…
                      </Badge>
                    ) : (
                      <StatusBadge
                        status={projectStatus}
                        variant={projectStatus === 'running' ? 'secondary' : undefined}
                      />
                    )}
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-3 gap-3">
                    <div className="min-w-0">
                      <dt className="text-xs text-muted-foreground">Eve version</dt>
                      <dd className="mt-2">
                        <EveVersionCardStatus eveVersion={project.eveVersion} />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Latest session</dt>
                      <dd className="mt-2">
                        <StatusBadge status={project.latestSessionStatus} />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Next schedule</dt>
                      <dd className="mt-2 whitespace-nowrap text-xs font-medium">
                        {project.nextScheduleAt ? (
                          <CompactDateTime
                            value={project.nextScheduleAt}
                            fallback={formatCompactDateTime(project.nextScheduleAt, renderedAt)}
                          />
                        ) : 'None'}
                      </dd>
                    </div>
                  </dl>
                </CardContent>
                <CardFooter className="justify-between border-t">
                  <span className="text-xs text-muted-foreground">
                    Updated {new Date(project.updatedAt).toLocaleString()}
                  </span>

                  {!deleting ? (
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
                  ) : null}
                </CardFooter>
              </Card>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
