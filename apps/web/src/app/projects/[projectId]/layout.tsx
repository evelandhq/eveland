import { notFound } from 'next/navigation';
import { StatusBadge } from '@/components/status-badge';
import { getProject } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

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
            {project.gitUrl ?? project.id}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={project.status} />
          <StatusBadge status={project.deploymentStatus} />
        </div>
      </header>
      <section className="px-5 py-5">{children}</section>
    </div>
  );
}
