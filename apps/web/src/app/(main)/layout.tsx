import { MainSidebar } from "@/components/main-sidebar";
import { SidebarShell } from "@/components/sidebar-shell";

export default function MainLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <SidebarShell mobileTitle="Eveland" sidebar={<MainSidebar />}>
      {children}
    </SidebarShell>
  );
}
