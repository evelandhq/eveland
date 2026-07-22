"use client";

import { usePathname } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const focusedRoute =
    pathname === "/new" ||
    pathname.startsWith("/auth") ||
    pathname === "/login" ||
    pathname === "/device" ||
    pathname.startsWith("/accept-invite") ||
    pathname.startsWith("/agent-auth");

  if (focusedRoute) return children;

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 px-4 md:hidden">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-4" />
          <span className="text-sm font-medium">Eveland</span>
        </header>
        <Separator className="md:hidden" />
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
