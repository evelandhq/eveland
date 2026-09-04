import Link from "next/link";
import { FolderIcon, RocketIcon } from "lucide-react";
import { DateTime } from "@/components/date-time";
import { PageContainer } from "@/components/page-container";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getDeploymentOverview, getProjects } from "@/lib/server-api";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Deployments",
};

export default async function DeploymentsPage() {
  const projects = await getProjects();
  const projectDeployments = await Promise.all(
    projects.map(async (project) => ({
      project,
      // This cross-project table is explicitly a history view ("including
      // archived and failed releases"), so it opts back into the archived
      // rows the per-project overview now withholds by default.
      overview: await getDeploymentOverview(project.id, { archived: "true", limit: "200" }),
    })),
  );
  const deployments = projectDeployments.flatMap(({ project, overview }) =>
    overview.deployments.map((deployment) => ({ deployment, project })),
  );
  // Each project's page is capped, so the count comes from the per-project
  // totals rather than from the rows that survived the cap.
  const totalCount = projectDeployments.reduce((sum, { overview }) => sum + overview.totalCount, 0);

  return (
    <PageContainer className="gap-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-[17px] font-semibold tracking-tight">Deployments</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Runtime deployments across every project, including archived and failed releases.
          </p>
        </div>
        <span className="text-sm text-muted-foreground">
          {deployments.length === totalCount
            ? `${totalCount} total`
            : `${deployments.length} of ${totalCount}`}
        </span>
      </div>

      {deployments.length === 0 ? (
        <div className="flex min-h-80 rounded-xl border bg-card">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <RocketIcon />
              </EmptyMedia>
              <EmptyTitle>No deployments yet</EmptyTitle>
              <EmptyDescription>
                Deployments will appear here after a project builds its first release.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Link href="/projects" className={buttonVariants({ variant: "outline" })}>
                <FolderIcon data-icon="inline-start" />
                View projects
              </Link>
            </EmptyContent>
          </Empty>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Project</TableHead>
                <TableHead>Deployment</TableHead>
                <TableHead>Runtime</TableHead>
                <TableHead>Host port</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deployments.map(({ deployment, project }) => (
                <TableRow key={deployment.id}>
                  <TableCell>
                    <Link href={`/projects/${project.id}`} className="font-medium hover:underline">
                      {project.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/projects/${project.id}`}
                        className="font-mono font-medium hover:underline"
                      >
                        {deployment.deploymentKey}
                      </Link>
                      {project.deploymentId === deployment.id ? (
                        <Badge variant="secondary">Production</Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>{deployment.runtimeKind}</TableCell>
                  <TableCell className="font-mono">{deployment.hostPort}</TableCell>
                  <TableCell>
                    <StatusBadge status={deployment.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <DateTime value={deployment.createdAt} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </PageContainer>
  );
}
