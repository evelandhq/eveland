import Link from "next/link";
import { BadgeCheckIcon, TriangleAlertIcon } from "lucide-react";
import { displayedDeploymentEveRefusal } from "@evelandhq/core/eve-compatibility";
import { DateTime } from "@/components/date-time";
import { DeploymentActions } from "@/components/deployment-actions";
import { DeploymentTrafficActions } from "@/components/deployment-traffic-actions";
import { EveVersionStatus } from "@/components/eve-version-status";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
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
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ archived?: string }>;
}) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  const showArchived = query.archived === "1";
  const [project, jobs, endpoints, eveVersion, overview, sourceRevision] = await Promise.all([
    getProject(projectId),
    getProjectJobs(projectId),
    getAgentEndpoints(projectId),
    getEveVersion(projectId),
    // Archived Deployments are the bulk of a long-lived project's history and
    // nothing on this page can act on them, so they stay behind a disclosure.
    getDeploymentOverview(projectId, showArchived ? { archived: "true", limit: "200" } : {}),
    getSourceRevision(projectId),
  ]);
  const latestImportJob = jobs.find((job) => job.type === "import_source") ?? null;
  const stableRoute = overview.routes.find((route) => route.kind === "project") ?? null;
  // Draining a Deployment any non-deployment route still sends traffic to is
  // refused by the API (409). The page holds the routes that decide it, so it
  // withholds the button instead of offering one that always fails.
  const routedDeploymentIds = new Set(
    overview.routes
      .filter((route) => route.kind !== "deployment")
      .flatMap((route) =>
        route.targets.filter((target) => target.weight > 0).map((target) => target.deploymentId),
      ),
  );

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Deployments</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Build releases, manage previews, and control production traffic.
          </p>
        </div>
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
            // The build-recorded refusal for this Deployment's own Release.
            // The project-level Eve badge reflects only the current
            // deployment (or source), so a retired Release that activation
            // now refuses terminally (#425) would otherwise be invisible.
            // Archived Deployments are excluded inside the helper: activation
            // refuses them on their status long before it reads the Eve
            // version, so an upgrade notice there is noise about work nobody
            // can do.
            const cannotStart = displayedDeploymentEveRefusal(
              deployment.status,
              overview.releaseSummaries[deployment.releaseId] ?? null,
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
                    {cannotStart ? (
                      <Badge variant="destructive">
                        <TriangleAlertIcon data-icon="inline-start" />
                        Cannot start
                      </Badge>
                    ) : null}
                  </div>
                  {cannotStart ? (
                    <p className="mt-1 text-xs text-destructive">Cannot start: {cannotStart}</p>
                  ) : null}
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
                  routed={routedDeploymentIds.has(deployment.id)}
                  retentionProtected={retention?.protected ?? true}
                />
              </div>
            );
          })}
          {overview.deployments.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              {showArchived || overview.archivedCount === 0
                ? "No deployments yet."
                : "No live deployments."}
            </p>
          ) : null}
        </div>
        {/* The list is a bounded page, so it says so whenever it is not the
            whole history -- and offers the way in and back out. */}
        {overview.deployments.length < overview.totalCount || showArchived ? (
          <div className="mt-3 flex items-center justify-between gap-4 text-xs text-muted-foreground">
            <span>
              Showing {overview.deployments.length} of {overview.totalCount} deployments
              {showArchived || overview.archivedCount === 0
                ? null
                : ` · ${overview.archivedCount} archived`}
            </span>
            {overview.archivedCount > 0 ? (
              <Link
                href={showArchived ? "?" : "?archived=1"}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                {showArchived ? "Hide archived" : "Show archived"}
              </Link>
            ) : null}
          </div>
        ) : null}
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
