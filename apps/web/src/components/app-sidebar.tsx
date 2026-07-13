"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { ArrowLeftIcon, SproutIcon } from "lucide-react"
import { ProjectNav } from "@/components/project-nav"
import { SignOutButton } from "@/components/sign-out-button"
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
} from "@/components/ui/sidebar"
import {
  getProjectIdFromPathname,
  globalNavigationItems,
  isNavigationItemActive,
} from "@/lib/navigation"

export function AppSidebar() {
  const pathname = usePathname()
  const projectId = getProjectIdFromPathname(pathname)
  if (pathname === "/login" || pathname.startsWith("/accept-invite")) return null

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            {projectId ? (
              <SidebarMenuButton
                render={<Link href="/projects" />}
                tooltip="Back to projects"
              >
                <ArrowLeftIcon />
                <span>Back to projects</span>
              </SidebarMenuButton>
            ) : (
              <SidebarMenuButton
                render={<Link href="/projects" />}
                size="lg"
                tooltip="Eveland"
              >
                <SproutIcon />
                <span className="font-semibold">Eveland</span>
              </SidebarMenuButton>
            )}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {projectId ? (
          <SidebarGroup>
            <SidebarGroupLabel>Project</SidebarGroupLabel>
            <SidebarGroupContent>
              <ProjectNav projectId={projectId} />
            </SidebarGroupContent>
          </SidebarGroup>
        ) : (
          <SidebarGroup>
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {globalNavigationItems.map((item) => {
                  const Icon = item.icon

                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        isActive={isNavigationItemActive(pathname, item.href)}
                        render={<Link href={item.href} />}
                        tooltip={item.label}
                      >
                        <Icon />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarFooter>
        <SignOutButton />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
