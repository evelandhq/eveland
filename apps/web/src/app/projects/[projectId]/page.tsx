import Link from "next/link";
import { getLogs, getProject, getSchedules, getSessions } from "@/lib/api";
import { DeploymentActions } from "@/components/deployment-actions";
import { NewChatForm } from "@/components/new-chat-form";
import { StatusBadge } from "@/components/status-badge";

export const dynamic = "force-dynamic";

export default async function ProjectOverviewPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const [project, sessions, schedules, logs] = await Promise.all([getProject(projectId), getSessions(projectId), getSchedules(projectId), getLogs(projectId)]);
  const recentFailureLog = project?.status === "failed" || project?.deploymentStatus === "failed" ? findRecentFailureLog(logs) : null;

  return (
    <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
      {recentFailureLog ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-destructive">Last failure</h2>
              <p className="mt-2 font-mono text-xs leading-5 text-destructive">{recentFailureLog.line}</p>
            </div>
            <Link href={`/projects/${projectId}/logs`} className="text-xs font-medium text-destructive underline-offset-4 hover:underline">
              Open logs
            </Link>
          </div>
        </div>
      ) : null}

      <div className="rounded-md border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">Deployment</h2>
            <p className="mt-1 text-xs text-muted-foreground">Current Production release and source revision.</p>
          </div>
          <DeploymentActions projectId={projectId} canDeploy={Boolean(project?.sourceRevisionId)} />
        </div>
        <dl className="grid grid-cols-2 gap-px bg-border text-sm">
          {[
            ["Deployment", project?.deploymentStatus ?? "unknown"],
            ["Source revision", project?.sourceRevisionId ?? "None"],
            ["Release", project?.releaseId ?? "None"],
            ["Deployment ID", project?.deploymentId ?? "None"],
          ].map(([label, value]) => (
            <div key={label} className="bg-card p-4">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="mt-2 font-medium">{value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="rounded-md border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">New chat</h2>
          <p className="mt-1 text-xs text-muted-foreground">Start a conversation bound to this agent.</p>
        </div>
        <div className="p-4">
          {project ? <NewChatForm projectId={project.id} projectName={project.name} disabled={project.deploymentStatus !== "running"} /> : null}
        </div>
      </div>

      <div className="rounded-md border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Recent state</h2>
        </div>
        <div className="flex flex-col gap-3 p-4 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Sessions</span>
            <span className="font-medium">{sessions.length}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Schedules</span>
            <span className="font-medium">{schedules.length}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Last session</span>
            <StatusBadge status={project?.latestSessionStatus ?? null} />
          </div>
        </div>
      </div>
    </div>
  );
}

function findRecentFailureLog(logs: Awaited<ReturnType<typeof getLogs>>) {
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const log = logs[index];
    if (log && /failed|error/i.test(log.line)) {
      return log;
    }
  }

  return logs.at(-1) ?? null;
}
