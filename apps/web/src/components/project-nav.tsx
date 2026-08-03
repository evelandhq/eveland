"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@/components/ui/sidebar";
import { getProjectNavigationItems, isNavigationItemActive } from "@/lib/navigation";

export function ProjectNav({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const items = getProjectNavigationItems(projectId);
  const dailyItems = items.filter((item) => item.section === "daily");
  const manageItems = items.filter((item) => item.section === "manage");

  return (
    <>
      <ProjectNavigationMenu items={dailyItems} pathname={pathname} />
      <SidebarSeparator className="my-2" />
      <ProjectNavigationMenu items={manageItems} pathname={pathname} />
    </>
  );
}

function ProjectNavigationMenu({
  items,
  pathname,
}: {
  items: ReadonlyArray<ReturnType<typeof getProjectNavigationItems>[number]>;
  pathname: string;
}) {
  return (
    <SidebarMenu>
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
