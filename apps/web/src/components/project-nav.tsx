"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { getProjectNavigationItems, isNavigationItemActive } from "@/lib/navigation";

export function ProjectNav({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const items = getProjectNavigationItems(projectId);
  const dailyItems = items.filter((item) => item.section === "daily");
  const manageItems = items.filter((item) => item.section === "manage");

  return (
    <>
      <ProjectNavigationMenu items={dailyItems} pathname={pathname} />
      {/* The two groups are separated by space, not a rule. A hairline here
          would be a second device for a boundary the gap already makes. */}
      <ProjectNavigationMenu className="mt-4" items={manageItems} pathname={pathname} />
    </>
  );
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
