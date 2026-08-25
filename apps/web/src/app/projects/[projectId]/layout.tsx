import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProjectContent } from "@/components/project-content";
import { ProjectSidebar } from "@/components/project-sidebar";
import { SidebarShell } from "@/components/sidebar-shell";
import { getEveVersion, getProject } from "@/lib/server-api";

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
  const eveVersion = await getEveVersion(project.id);

  return (
    <SidebarShell
      mobileTitle={project.name}
      sidebar={
        <ProjectSidebar
          deploymentStatus={project.deploymentStatus}
          eveVersion={eveVersion}
          projectId={project.id}
          projectName={project.name}
        />
      }
    >
      <ProjectContent deletionError={project.deletionError} deletionStatus={project.deletionStatus}>
        {children}
      </ProjectContent>
    </SidebarShell>
  );
}
