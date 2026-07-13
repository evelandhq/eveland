"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { getProjectNavigationItems, isNavigationItemActive } from "@/lib/navigation"

export function ProjectNav({ projectId }: { projectId: string }) {
  const pathname = usePathname()

  return (
    <SidebarMenu>
      {getProjectNavigationItems(projectId).map((item) => {
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
  );
}
