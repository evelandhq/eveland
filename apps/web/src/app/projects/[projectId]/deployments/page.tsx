import { BadgeCheckIcon } from "lucide-react";
import { DateTime } from "@/components/date-time";
import { DeploymentActions } from "@/components/deployment-actions";
import { DeploymentTrafficActions } from "@/components/deployment-traffic-actions";
import { EveVersionStatus } from "@/components/eve-version-status";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import {
  getAgentEndpoints,
  getDeploymentOverview,
  getEveVersion,
  getProject,
  getProjectJobs,
  getSourceRevision,
} from "@/lib/server-api";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Deployments",
};

export default async function ProjectDeploymentsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const [project, jobs, endpoints, eveVersion, overview, sourceRevision] = await Promise.all([
    getProject(projectId),
    getProjectJobs(projectId),
    getAgentEndpoints(projectId),
    getEveVersion(projectId),
    getDeploymentOverview(projectId),
    getSourceRevision(projectId),
  ]);
  const latestImportJob = jobs.find((job) => job.type === "import_source") ?? null;
  const stableRoute = overview.routes.find((route) => route.kind === "project") ?? null;

  return (
    <div className="flex flex-col gap-8">
      {/* The heading stays for screen readers only — sighted readers already
          have it in the breadcrumb, and the description restated what the
          buttons beside it do. */}
      <header className="flex flex-wrap items-end justify-end gap-4">
        <h2 className="sr-only">Deployments</h2>
        <DeploymentActions
          projectId={projectId}
          canSync={project?.importKind === "git" && Boolean(project?.gitUrl)}
          canDeploy={Boolean(project?.sourceRevisionId)}
          importJob={latestImportJob}
          sourceRevisionId={sourceRevision?.id ?? null}
          sourceCommitSha={sourceRevision?.commitSha ?? null}
          sourceRecordedAt={sourceRevision?.createdAt ?? null}
        />
      </header>

      {/* One bordered card for production context, mirroring the overview:
          the stable endpoint — the value you actually paste somewhere — gets
          the size on top, and the release facts sit below a hairline as a
          quiet grid. */}
      <section
        aria-labelledby="production-deployment-heading"
        className="flex flex-col gap-4 rounded-xl border p-5"
      >
        <h3 id="production-deployment-heading" className="sr-only">
          Production
        </h3>
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-xs text-muted-foreground">Stable endpoint</p>
          {endpoints.stable ? (
            <a
              href={endpoints.stable}
              target="_blank"
              rel="noreferrer"
              className="break-all font-mono text-base font-medium underline-offset-4 hover:underline"
            >
              {endpoints.stable}
            </a>
          ) : (
            <p className="text-base font-medium text-muted-foreground">None</p>
          )}
        </div>
        <dl className="grid gap-4 border-t pt-4 text-xs sm:grid-cols-2 lg:grid-cols-3">
          <DeploymentFact
            label="Deployment"
            value={<StatusBadge status={project?.deploymentStatus ?? "unknown"} />}
          />
          <DeploymentFact label="Eve Agent" value={<EveVersionStatus eveVersion={eveVersion} />} />
          <DeploymentFact
            label="Source revision"
            value={<span className="font-mono">{project?.sourceRevisionId ?? "None"}</span>}
          />
          <DeploymentFact
            label="Release"
            value={<span className="font-mono">{project?.releaseId ?? "None"}</span>}
          />
          <DeploymentFact
            label="Latest preview"
            value={
              endpoints.previews.at(-1) ? (
                <a
                  href={endpoints.previews.at(-1)}
                  target="_blank"
                  rel="noreferrer"
                  className="underline-offset-4 hover:underline"
                >
                  {endpoints.previews.at(-1)}
                </a>
              ) : (
                "None"
              )
            }
          />
        </dl>
      </section>

      <section aria-labelledby="deployment-traffic-heading">
        <div>
          <h3 id="deployment-traffic-heading" className="text-base font-semibold">
            Deployments &amp; traffic
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Stable marks deployments receiving production traffic; manage previews, rollbacks,
            splits, drain, and retention.
          </p>
        </div>
        <div className="mt-3 divide-y overflow-hidden rounded-xl border">
          {overview.deployments.map((deployment) => {
            const stableTarget =
              stableRoute?.targets.find((target) => target.deploymentId === deployment.id) ?? null;
            const retention = overview.retention.find(
              (entry) => entry.deployment.id === deployment.id,
            );
            return (
              <div
                key={deployment.id}
                className="grid gap-3 p-4 text-sm md:grid-cols-[1fr_auto] md:items-center"
              >
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
                    Deployed <DateTime value={deployment.createdAt} />
                    {" · "}
                    {deployment.runtimeKind}
                    {" · "}
                    {retention?.protected
                      ? `protected: ${retention.reasons.join(", ")}`
                      : "eligible for archive"}
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
          {overview.deployments.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No deployments yet.</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function DeploymentFact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm font-medium break-words">{value}</dd>
    </div>
  );
}
