"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ChevronsUpDownIcon, FolderIcon, LogOutIcon, SettingsIcon, SproutIcon } from "lucide-react";
import { EVELAND_VERSION } from "@evelandhq/core/build-info";
import { ProjectNav } from "@/components/project-nav";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
} from "@/components/ui/sidebar";
import {
  getProjectIdFromPathname,
  getSettingsNavigationGroups,
  globalNavigationItems,
  isNavigationItemActive,
} from "@/lib/navigation";
import type { Project } from "@/lib/api";
import { getCurrentMember, listProjects, signOut, type CurrentMember } from "@/lib/client-api";

export function AppSidebar() {
  const pathname = usePathname();
  const projectId = getProjectIdFromPathname(pathname);
  const isSettings = pathname.startsWith("/settings");
  const [member, setMember] = useState<CurrentMember | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const settingsNavigationGroups = getSettingsNavigationGroups(member?.role ?? null);

  // The switcher needs names, not just the id in the URL. One list fetch per
  // project context; failures degrade to a generic label, never an error.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void listProjects()
      .then((all) => {
        if (!cancelled) setProjects(all);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (pathname === "/login" || pathname.startsWith("/accept-invite")) return;
    let cancelled = false;
    void getCurrentMember()
      .then((current) => {
        if (!cancelled) setMember(current);
      })
      .catch(() => undefined);
    const updateMember = (event: Event) => {
      const detail = (event as CustomEvent<CurrentMember>).detail;
      if (detail) setMember(detail);
    };
    window.addEventListener("eveland:profile-updated", updateMember);
    return () => {
      cancelled = true;
      window.removeEventListener("eveland:profile-updated", updateMember);
    };
  }, [pathname]);

  if (pathname === "/login" || pathname.startsWith("/accept-invite")) return null;

  const memberLabel = member?.name ?? member?.email ?? "Account";
  const memberInitials = memberLabel.slice(0, 2).toUpperCase();

  return (
    // The sidebar shares the canvas background, so a divider would be a second
    // separator for a boundary the layout already makes obvious. The variant
    // prefix has to match the one Sidebar sets, or tailwind-merge keeps both.
    <Sidebar className="group-data-[side=left]:border-r-0" collapsible="icon">
      <SidebarHeader>
        <SidebarMenu className="gap-px">
          {/* The logo row is the constant anchor at the top of every context:
              it names the product and IS the way back up to the workspace. */}
          <SidebarMenuItem>
            <SidebarMenuButton render={<Link href="/projects" />} tooltip="Eveland">
              <SproutIcon />
              <span className="font-semibold">Eveland</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {projectId ? (
            <SidebarMenuItem>
              {/* The seam between the two navigation levels: a bordered
                  switcher control, not a nav row — it jumps straight to any
                  other project without surfacing through the list page. */}
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <SidebarMenuButton
                      size="lg"
                      className="border bg-background group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent"
                      tooltip="Switch project"
                    />
                  }
                >
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-success-subtle text-success-foreground">
                    <FolderIcon className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1 truncate font-semibold">
                    {projects.find((project) => project.id === projectId)?.name ?? "Project"}
                  </span>
                  <ChevronsUpDownIcon className="text-muted-foreground" />
                </DropdownMenuTrigger>
                <DropdownMenuContent side="bottom" align="start" sideOffset={6} className="w-56">
                  <DropdownMenuGroup>
                    {projects.map((project) => (
                      <DropdownMenuItem
                        key={project.id}
                        render={<Link href={`/projects/${project.id}`} />}
                        data-active={project.id === projectId || undefined}
                      >
                        <FolderIcon />
                        <span className="min-w-0 flex-1 truncate">{project.name}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuItem render={<Link href="/projects" />}>
                      All projects
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          ) : null}
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {isSettings ? (
          settingsNavigationGroups.map((group) => (
            <SidebarGroup key={group.label}>
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu className="gap-px">
                  {group.items.map((item) => {
                    const Icon = item.icon;

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
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))
        ) : projectId ? (
          <SidebarGroup>
            <SidebarGroupContent>
              <ProjectNav projectId={projectId} />
            </SidebarGroupContent>
          </SidebarGroup>
        ) : (
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu className="gap-px">
                {globalNavigationItems.map((item) => {
                  const Icon = item.icon;

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
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu className="gap-px">
          {/* Version above the account row, as quiet small print — no icon,
              no divider. The account row keeps the bottom anchor position. */}
          <SidebarMenuItem className="group-data-[collapsible=icon]:hidden">
            <Link
              href="/settings/about"
              className="block truncate px-2 py-1 text-[11px] text-muted-foreground/70 hover:text-muted-foreground"
            >
              Eveland v{EVELAND_VERSION}
            </Link>
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
                  <span className="truncate text-xs text-muted-foreground">
                    {member?.email ?? "Loading account…"}
                  </span>
                </span>
                <ChevronsUpDownIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-56">
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
                      await signOut();
                      window.location.assign("/login");
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
  );
}
