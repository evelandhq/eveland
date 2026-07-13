"use client";

import { LogOutIcon } from "lucide-react";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { signOut } from "@/lib/client-api";

export function SignOutButton() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          tooltip="Sign out"
          onClick={async () => {
            await signOut();
            window.location.assign("/login");
          }}
        >
          <LogOutIcon />
          <span>Sign out</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
