"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const tabs = [
  { segment: "general", label: "General" },
  { segment: "environment", label: "Environment" },
] as const;

export function ProjectSettingsNav({ projectId }: { projectId: string }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Project settings" className="flex flex-col gap-1">
      {tabs.map((tab) => {
        const href = `/projects/${projectId}/settings/${tab.segment}`;
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={tab.segment}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
              active && "bg-muted text-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
