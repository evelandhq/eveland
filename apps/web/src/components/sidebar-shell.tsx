"use client";

import type { ReactNode } from "react";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";

export function SidebarShell({
  children,
  mobileTitle,
  sidebar,
}: {
  children: ReactNode;
  mobileTitle: string;
  sidebar: ReactNode;
}) {
  return (
    <SidebarProvider>
      {sidebar}
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 px-4 md:hidden">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-4" />
          <span className="truncate text-sm font-medium">{mobileTitle}</span>
        </header>
        <Separator className="md:hidden" />
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
