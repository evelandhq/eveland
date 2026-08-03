import { ProjectSecretsSettings } from "@/components/project-secrets-settings";
import { getSecrets } from "@/lib/server-api";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Environment settings",
};

export default async function ProjectEnvironmentSettingsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const secrets = await getSecrets(projectId);

  return <ProjectSecretsSettings projectId={projectId} initialEntries={secrets} />;
}
