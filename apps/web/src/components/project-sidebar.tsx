import Link from "next/link";
import { ArrowLeftIcon } from "lucide-react";
import { EveVersionStatus } from "@/components/eve-version-status";
import { ProjectNav } from "@/components/project-nav";
import { StatusBadge } from "@/components/status-badge";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
} from "@/components/ui/sidebar";
import type { EveVersionInfo, Project } from "@/lib/api";

export function ProjectSidebar({
  deploymentStatus,
  eveVersion,
  projectId,
  projectName,
}: {
  deploymentStatus: Project["deploymentStatus"];
  eveVersion: EveVersionInfo;
  projectId: string;
  projectName: string;
}) {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton render={<Link href="/projects" />} tooltip="Back to projects">
              <ArrowLeftIcon />
              <span>Back to projects</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{projectName}</SidebarGroupLabel>
          <SidebarGroupContent>
            <ProjectNav projectId={projectId} />
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarSeparator className="group-data-[collapsible=icon]:hidden" />
      <SidebarFooter className="group-data-[collapsible=icon]:hidden">
        <dl className="flex flex-col gap-2 px-2 py-1">
          <div className="flex items-center justify-between gap-2">
            <dt className="text-xs text-muted-foreground">Status</dt>
            <dd>
              <StatusBadge status={deploymentStatus} />
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-xs text-muted-foreground">Version</dt>
            <dd>
              <EveVersionStatus
                className="justify-end"
                eveVersion={eveVersion}
                showMessage={false}
                tooltipWhenCurrent={false}
              />
            </dd>
          </div>
        </dl>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
