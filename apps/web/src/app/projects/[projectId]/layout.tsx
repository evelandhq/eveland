import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProjectDeletionNotice } from "@/components/project-deletion-notice";
import { ProjectDeletionPoller } from "@/components/project-deletion-poller";
import { PAGE_INSET, PageContainer } from "@/components/page-container";
import { ProjectBreadcrumb } from "@/components/project-breadcrumb";
import { ProjectSidebar } from "@/components/project-sidebar";
import { SidebarShell } from "@/components/sidebar-shell";
import { StatusBadge } from "@/components/status-badge";
import { cn } from "@/lib/utils";
import { getProject } from "@/lib/server-api";

export const dynamic = "force-dynamic";

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
    <SidebarShell
      mobileTitle={project.name}
      sidebar={<ProjectSidebar projectId={project.id} projectName={project.name} />}
    >
      <div className="min-h-[calc(100svh-3rem)] bg-background">
        <header>
          <div className={cn(PAGE_INSET, "pt-5")}>
            <ProjectBreadcrumb
              projectDescription={project.description ?? null}
              projectId={project.id}
              projectName={project.name}
              status={
                <>
                  <StatusBadge
                    status={
                      project.deletionStatus === "failed"
                        ? "delete_failed"
                        : (project.deletionStatus ?? project.status)
                    }
                  />
                  <StatusBadge status={project.deploymentStatus} />
                </>
              }
            />
          </div>
        </header>
        <PageContainer className="gap-4">
          <ProjectDeletionPoller active={project.deletionStatus === "deleting"} />
          <ProjectDeletionNotice status={project.deletionStatus} error={project.deletionError} />
          <fieldset disabled={project.deletionStatus === "deleting"} className="contents">
            {children}
          </fieldset>
        </PageContainer>
      </div>
    </SidebarShell>
  );
}
