import { notFound } from "next/navigation";
import { ProjectDangerZone } from "@/components/project-danger-zone";
import { ProjectGeneralSettings } from "@/components/project-general-settings";
import { ProjectSecretsSettings } from "@/components/project-secrets-settings";
import { Separator } from "@/components/ui/separator";
import { getProject, getSecrets } from "@/lib/server-api";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Settings",
};

export default async function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const [project, secrets] = await Promise.all([getProject(projectId), getSecrets(projectId)]);

  if (!project) notFound();

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <header>
        <h2 className="text-2xl font-semibold tracking-tight">Settings</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Project details, runtime configuration, and deletion.
        </p>
      </header>

      <section aria-labelledby="project-details-heading" className="flex flex-col gap-5">
        <div>
          <h3 id="project-details-heading" className="text-base font-semibold">
            Project details
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Display metadata can change; the slug and Project ID remain stable.
          </p>
        </div>
        <ProjectGeneralSettings project={project} />
      </section>

      <Separator />

      <ProjectSecretsSettings projectId={projectId} initialEntries={secrets} />

      <Separator />

      <ProjectDangerZone project={project} />
    </div>
  );
}
