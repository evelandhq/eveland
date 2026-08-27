import { PageContainer } from "@/components/page-container";
import { ModelGatewaySidebar } from "@/components/model-gateway-sidebar";
import { SidebarShell } from "@/components/sidebar-shell";

export default function ModelGatewayLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <SidebarShell mobileTitle="Model Gateway" sidebar={<ModelGatewaySidebar />}>
      <PageContainer className="max-w-4xl">
        <div className="mt-4 w-full min-w-0">{children}</div>
      </PageContainer>
    </SidebarShell>
  );
}
