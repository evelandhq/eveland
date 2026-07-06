import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeftIcon } from 'lucide-react';
import { ProjectNav } from '@/components/project-nav';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { getProject } from '@/lib/api';

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
    <main className="min-h-screen bg-background">
      <header className="flex h-14 items-center justify-between border-b border-border px-5">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/projects">
            <ArrowLeftIcon data-icon="inline-start" />
            Projects
          </Link>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">{project.name}</h1>
            <div className="truncate text-xs text-muted-foreground">
              {project.gitUrl ?? project.id}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={project.status} />
          <StatusBadge status={project.deploymentStatus} />
        </div>
      </header>
      <ProjectNav projectId={project.id} />
      <section className="px-5 py-5">{children}</section>
    </main>
  );
}
