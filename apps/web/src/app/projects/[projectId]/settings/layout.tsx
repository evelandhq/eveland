import { ProjectSettingsNav } from "@/components/project-settings-nav";

export default async function ProjectSettingsLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}>) {
  const { projectId } = await params;

  return (
    <div className="grid min-w-0 gap-8 md:grid-cols-[10rem_minmax(0,1fr)]">
      <aside className="min-w-0 md:border-r md:border-border md:pr-6">
        <ProjectSettingsNav projectId={projectId} />
      </aside>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
