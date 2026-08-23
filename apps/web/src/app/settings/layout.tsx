import { PageContainer } from "@/components/page-container";

export default function SettingsLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <PageContainer className="max-w-4xl">
      <div className="mt-4 w-full min-w-0">{children}</div>
    </PageContainer>
  );
}
