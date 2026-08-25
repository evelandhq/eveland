import { PageContainer } from "@/components/page-container";
import { SettingsSidebar } from "@/components/settings-sidebar";
import { SidebarShell } from "@/components/sidebar-shell";

export default function SettingsLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <SidebarShell mobileTitle="Settings" sidebar={<SettingsSidebar />}>
      <PageContainer className="max-w-4xl">
        <div className="mt-4 w-full min-w-0">{children}</div>
      </PageContainer>
    </SidebarShell>
  );
}
