import { PageContainer } from "@/components/page-container";

export default function SettingsLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <PageContainer className="gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage your account and this Eveland workspace.
        </p>
      </header>
      {/* One measure for every settings tab. The sub-pages used to each pick
          their own (5xl, 2xl, or none), so the right edge jumped as you moved
          between them even though the left one did not. */}
      <div className="min-w-0 max-w-4xl">{children}</div>
    </PageContainer>
  );
}
