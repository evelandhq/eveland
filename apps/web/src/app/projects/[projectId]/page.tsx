import Link from "next/link";
import { BadgeCheckIcon } from "lucide-react";
import { getAgentEndpoints, getDeploymentOverview, getLogs, getProject, getSchedules, getSessions, getVariantMetrics } from "@/lib/server-api";
import { DeploymentActions } from "@/components/deployment-actions";
import { DeploymentTrafficActions } from "@/components/deployment-traffic-actions";
import { ProjectDangerZone } from "@/components/project-danger-zone";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export default async function ProjectOverviewPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const [project, endpoints, sessions, schedules, logs, deploymentOverview, variantMetrics] = await Promise.all([
    getProject(projectId),
    getAgentEndpoints(projectId),
    getSessions(projectId),
    getSchedules(projectId),
    getLogs(projectId),
    getDeploymentOverview(projectId),
    getVariantMetrics(projectId),
  ]);
  const recentFailureLog = project?.status === "failed" || project?.deploymentStatus === "failed" ? findRecentFailureLog(logs) : null;
  const stableRoute = deploymentOverview.routes.find((route) => route.kind === "project") ?? null;

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
          <DeploymentActions
            projectId={projectId}
            importKind={project?.importKind === "git" ? "git" : "zip"}
            canSync={project?.importKind === "git" && Boolean(project?.gitUrl)}
            canDeploy={Boolean(project?.sourceRevisionId)}
          />
        </div>
        <dl className="grid grid-cols-2 gap-px bg-border text-sm">
          {(
            [
            ["Deployment", project?.deploymentStatus ?? "unknown"],
            ["Source revision", project?.sourceRevisionId ?? "None"],
            ["Release", project?.releaseId ?? "None"],
            ["Stable endpoint", endpoints.stable ?? "None"],
            ["Preview endpoint", endpoints.previews.at(-1) ?? "None"],
            ] satisfies Array<[string, string]>
          ).map(([label, value]) => (
            <div key={label} className="bg-card p-4 last:col-span-2">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="mt-2 break-all font-medium">
                {label.endsWith("endpoint") && value !== "None" ? (
                  <a href={value} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
                    {value}
                  </a>
                ) : (
                  value
                )}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="rounded-md border border-border bg-card lg:col-span-2">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Deployments &amp; traffic</h2>
          <p className="mt-1 text-xs text-muted-foreground">Stable marks deployments receiving production traffic; manage previews, rollbacks, splits, drain, and retention.</p>
        </div>
        <div className="divide-y divide-border">
          {deploymentOverview.deployments.map((deployment) => {
            const stableTarget = stableRoute?.targets.find((target) => target.deploymentId === deployment.id) ?? null;
            const retention = deploymentOverview.retention.find((entry) => entry.deployment.id === deployment.id);
            return (
              <div key={deployment.id} className="grid gap-3 p-4 text-sm md:grid-cols-[1fr_auto] md:items-center">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono font-medium">{deployment.deploymentKey}</span>
                    {stableTarget ? (
                      <Badge>
                        <BadgeCheckIcon data-icon="inline-start" />
                        Stable · {stableTarget.weight / 100}% traffic
                      </Badge>
                    ) : null}
                    <StatusBadge status={deployment.status} />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    <time dateTime={deployment.createdAt}>
                      Deployed {new Date(deployment.createdAt).toLocaleString()}
                    </time>
                    {" · "}{deployment.runtimeKind} · {retention?.protected ? `protected: ${retention.reasons.join(", ")}` : "eligible for archive"}
                  </p>
                </div>
                <DeploymentTrafficActions
                  projectId={projectId}
                  deploymentId={deployment.id}
                  productionDeploymentId={project?.deploymentId ?? null}
                  stableRouteId={stableRoute?.id ?? null}
                  status={deployment.status}
                  retentionProtected={retention?.protected ?? true}
                />
              </div>
            );
          })}
          {deploymentOverview.deployments.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No deployments yet.</p> : null}
        </div>
      </div>

      <div className="rounded-md border border-border bg-card lg:col-span-2">
        <div className="border-b border-border px-4 py-3"><h2 className="text-sm font-semibold">Variant metrics</h2></div>
        <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-4">
          {variantMetrics.map((metric) => (
            <div key={`${metric.deploymentId}:${metric.experimentId}:${metric.variantName}`} className="bg-card p-4 text-sm">
              <p className="font-medium">{metric.variantName}</p>
              <p className="mt-1 truncate text-xs text-muted-foreground">{metric.experimentId ?? "no experiment"} · {metric.deploymentId ?? "unassigned"}</p>
              <p className="mt-2 text-xs text-muted-foreground">{metric.success} success / {metric.failure} failed · {Math.round(metric.averageLatencyMs)}ms avg</p>
              <p className="mt-1 text-xs text-muted-foreground">{metric.tokens} tokens · ${metric.costUsd.toFixed(4)}</p>
            </div>
          ))}
          {variantMetrics.length === 0 ? <p className="bg-card p-4 text-sm text-muted-foreground">No variant sessions yet.</p> : null}
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

      {project ? <ProjectDangerZone project={project} /> : null}
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
