import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ProjectDeletionNotice } from '@/components/project-deletion-notice';
import { ProjectDeletionPoller } from '@/components/project-deletion-poller';
import { StatusBadge } from '@/components/status-badge';
import { getProject } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): Promise<Metadata> {
  const { projectId } = await params;
  const project = await getProject(projectId);

  if (!project) {
    return { title: "Project" };
  }

  return {
    title: {
      default: project.name,
      template: `%s · ${project.name} | Eveland`,
    },
  };
}

export default async function ProjectLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}>) {
  const { projectId } = await params;
  const project = await getProject(projectId);

  if (!project) {
    notFound();
  }

  return (
    <div className="min-h-[calc(100svh-3rem)] bg-background">
      <header className="flex h-14 items-center justify-between border-b border-border px-5">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">{project.name}</h1>
          <div className="truncate text-xs text-muted-foreground">
            {project.description ?? project.gitUrl ?? project.id}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={project.deletionStatus === 'failed' ? 'delete_failed' : project.deletionStatus ?? project.status} />
          <StatusBadge status={project.deploymentStatus} />
        </div>
      </header>
      <section className="flex flex-col gap-4 px-5 py-5">
        <ProjectDeletionPoller active={project.deletionStatus === 'deleting'} />
        <ProjectDeletionNotice status={project.deletionStatus} error={project.deletionError} />
        <fieldset disabled={project.deletionStatus === 'deleting'} className="contents">
          {children}
        </fieldset>
      </section>
    </div>
  );
}
