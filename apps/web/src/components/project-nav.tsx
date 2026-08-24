"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { getScheduleAttention } from "@/lib/client-api";
import { getProjectNavigationItems, isNavigationItemActive } from "@/lib/navigation";

export function ProjectNav({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const items = getProjectNavigationItems(projectId);
  // Failed scheduled runs nobody has reviewed (#294): the count follows the
  // reader into every project page, so an unattended failure is visible
  // without anyone thinking to open Schedules. Refreshed per navigation, not
  // polled.
  const [attention, setAttention] = useState(0);
  useEffect(() => {
    let cancelled = false;
    getScheduleAttention(projectId)
      .then((count) => {
        if (!cancelled) setAttention(count);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId, pathname]);

  // One flat, evenly spaced list: the daily/manage split turned out to be a
  // boundary readers never needed — nine items scan fine as a single column.
  return (
    <ProjectNavigationMenu
      className="gap-px"
      items={items}
      pathname={pathname}
      scheduleAttention={attention}
      scheduleHref={`/projects/${projectId}/schedules`}
    />
  );
}

function ProjectNavigationMenu({
  className,
  items,
  pathname,
  scheduleAttention,
  scheduleHref,
}: {
  className?: string;
  items: ReadonlyArray<ReturnType<typeof getProjectNavigationItems>[number]>;
  pathname: string;
  scheduleAttention: number;
  scheduleHref: string;
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
            {item.href === scheduleHref && scheduleAttention > 0 ? (
              <SidebarMenuBadge className="bg-destructive-subtle text-destructive-foreground">
                {scheduleAttention}
              </SidebarMenuBadge>
            ) : null}
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}
