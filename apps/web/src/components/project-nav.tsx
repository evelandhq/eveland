"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { getProjectNavigationItems, isNavigationItemActive } from "@/lib/navigation";

export function ProjectNav({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const items = getProjectNavigationItems(projectId);

  // One flat, evenly spaced list: the daily/manage split turned out to be a
  // boundary readers never needed — nine items scan fine as a single column.
  return <ProjectNavigationMenu items={items} pathname={pathname} />;
}

function ProjectNavigationMenu({
  className,
  items,
  pathname,
}: {
  className?: string;
  items: ReadonlyArray<ReturnType<typeof getProjectNavigationItems>[number]>;
  pathname: string;
}) {
  return (
    <SidebarMenu className={className}>
      {items.map((item) => {
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
