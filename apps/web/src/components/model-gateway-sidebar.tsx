"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ArrowLeftIcon, BoxesIcon, KeyRoundIcon, PlugZapIcon, WaypointsIcon } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { isNavigationItemActive } from "@/lib/navigation";
import { getCurrentMember, type CurrentMember } from "@/lib/client-api";

const memberItems = [
  { href: "/model-gateway", label: "Overview", icon: WaypointsIcon },
  { href: "/model-gateway/models", label: "Models", icon: BoxesIcon },
  { href: "/model-gateway/api-keys", label: "API Keys", icon: KeyRoundIcon },
] as const;

const adminItems = [
  { href: "/model-gateway/providers", label: "Providers", icon: PlugZapIcon },
] as const;

export function ModelGatewaySidebar() {
  const pathname = usePathname();
  const [member, setMember] = useState<CurrentMember | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getCurrentMember()
      .then((current) => {
        if (!cancelled) setMember(current);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const items = member?.role === "admin" ? [...memberItems, ...adminItems] : [...memberItems];

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton render={<Link href="/projects" />} tooltip="Back to home">
              <ArrowLeftIcon />
              <span>Back to home</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Model Gateway</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => {
                const Icon = item.icon;
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      isActive={
                        item.href === "/model-gateway"
                          ? pathname === item.href
                          : isNavigationItemActive(pathname, item.href)
                      }
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
      <SidebarRail />
    </Sidebar>
  );
}
