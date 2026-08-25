import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProjectDeletionNotice } from "@/components/project-deletion-notice";
import { ProjectDeletionPoller } from "@/components/project-deletion-poller";
import { PageContainer } from "@/components/page-container";
import { ProjectSidebar } from "@/components/project-sidebar";
import { SidebarShell } from "@/components/sidebar-shell";
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
