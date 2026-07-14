"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { usePathname } from "next/navigation"
import { ArrowLeftIcon, BadgeInfoIcon, ChevronsUpDownIcon, LogOutIcon, SettingsIcon, SproutIcon } from "lucide-react"
import { EVELAND_VERSION } from "@eveland/core/build-info"
import { ProjectNav } from "@/components/project-nav"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
  settingsNavigationGroups,
} from "@/lib/navigation"
import { getCurrentMember, signOut, type CurrentMember } from "@/lib/client-api"

export function AppSidebar() {
  const pathname = usePathname()
  const projectId = getProjectIdFromPathname(pathname)
  const isSettings = pathname.startsWith("/settings")
  const [member, setMember] = useState<CurrentMember | null>(null)

  useEffect(() => {
    if (pathname === "/login" || pathname.startsWith("/accept-invite")) return
    let cancelled = false
    void getCurrentMember().then((current) => {
      if (!cancelled) setMember(current)
    }).catch(() => undefined)
    const updateMember = (event: Event) => {
      const detail = (event as CustomEvent<CurrentMember>).detail
      if (detail) setMember(detail)
    }
    window.addEventListener("eveland:profile-updated", updateMember)
    return () => {
      cancelled = true
      window.removeEventListener("eveland:profile-updated", updateMember)
    }
  }, [pathname])

  if (pathname === "/login" || pathname.startsWith("/accept-invite")) return null

  const memberLabel = member?.name ?? member?.email ?? "Account"
  const memberInitials = memberLabel.slice(0, 2).toUpperCase()

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            {projectId || isSettings ? (
              <SidebarMenuButton
                render={<Link href="/projects" />}
                tooltip={projectId ? "Back to projects" : "Back to workspace"}
              >
                <ArrowLeftIcon />
                <span>{projectId ? "Back to projects" : "Back to workspace"}</span>
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
        {isSettings ? (
          settingsNavigationGroups.map((group) => (
            <SidebarGroup key={group.label}>
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => {
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
          ))
        ) : projectId ? (
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
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link href="/settings/about" />}
              size="sm"
              tooltip={`Eveland v${EVELAND_VERSION}`}
            >
              <BadgeInfoIcon />
              <span>Eveland v{EVELAND_VERSION}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger render={<SidebarMenuButton size="lg" />}>
                <Avatar size="sm">
                  {member?.image ? <AvatarImage src={member.image} alt={memberLabel} /> : null}
                  <AvatarFallback>{memberInitials}</AvatarFallback>
                </Avatar>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{memberLabel}</span>
                  <span className="truncate text-xs text-muted-foreground">{member?.email ?? "Loading account…"}</span>
                </span>
                <ChevronsUpDownIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="end" sideOffset={8} className="w-56">
                <DropdownMenuGroup>
                  <DropdownMenuItem render={<Link href="/settings/profile" />}>
                    <SettingsIcon />
                    Settings
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    onClick={async () => {
                      await signOut()
                      window.location.assign("/login")
                    }}
                  >
                    <LogOutIcon />
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
