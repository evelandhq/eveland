"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ChevronsUpDownIcon, LogOutIcon, SettingsIcon } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { EVELAND_VERSION } from "@evelandhq/core/build-info";
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
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { globalNavigationItems, isNavigationItemActive } from "@/lib/navigation";
import { getCurrentMember, signOut, type CurrentMember } from "@/lib/client-api";

export function MainSidebar() {
  const pathname = usePathname();
  const [member, setMember] = useState<CurrentMember | null>(null);

  useEffect(() => {
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
  }, []);

  const memberLabel = member?.name ?? member?.email ?? "Account";
  const memberInitials = memberLabel.slice(0, 2).toUpperCase();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton render={<Link href="/projects" />} tooltip="Eveland">
              <BrandMark />
              <span className="font-semibold">Eveland</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
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
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
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
