import Link from 'next/link';
import { PlusIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/status-badge';
import { getCollectorHealth, getProjects } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function ProjectsPage() {
  const [projects, collector] = await Promise.all([getProjects(), getCollectorHealth()]);

  return (
    <main className="min-h-screen bg-background">
      <header className="flex h-14 items-center justify-between border-b border-border px-6">
        <div className="flex items-baseline gap-3">
          <h1 className="text-base font-semibold">Eveland</h1>
          <span className="text-xs text-muted-foreground">eve runtime control plane</span>
        </div>
        <Link href="/projects/new">
          <PlusIcon data-icon="inline-start" />
          New project
        </Link>
      </header>

      <section className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-6 py-6">
        {collector.status !== "healthy" ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
            <div className="font-medium">Session collector {collector.status}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {collector.backlogEvents} queued events · {collector.backlogBytes} bytes · oldest {collector.oldestEventAge} ms · {collector.quarantinedEvents} quarantined
              {collector.lastError ? ` · ${collector.lastError}` : ""}
            </div>
          </div>
        ) : null}
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold tracking-normal">Projects</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Imported eve agents, deployments, schedules, and recent runtime state.
            </p>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <div>{projects.length} total</div>
            <div>Production only</div>
          </div>
        </div>

        <div className="overflow-hidden rounded-md border border-border bg-card">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Name</th>
                <th className="px-4 py-2 text-left font-medium">Deploy</th>
                <th className="px-4 py-2 text-left font-medium">Session</th>
                <th className="px-4 py-2 text-left font-medium">Next schedule</th>
                <th className="px-4 py-2 text-left font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {projects.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-sm text-muted-foreground">
                    No projects yet. Import a Git repo or Zip source to start the first deployment.
                  </td>
                </tr>
              ) : (
                projects.map((project) => (
                  <tr key={project.id} className="border-t border-border hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <Link
                        href={`/projects/${project.id}`}
                        className="font-medium hover:underline"
                      >
                        {project.name}
                      </Link>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {project.gitUrl ?? project.importKind.toUpperCase()}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={project.deploymentStatus} />
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={project.latestSessionStatus} />
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {project.nextScheduleAt ?? 'None'}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {new Date(project.updatedAt).toLocaleString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
