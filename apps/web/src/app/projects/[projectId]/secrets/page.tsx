import { getSecrets } from "@/lib/server-api";
import { ProjectSecretsSettings } from "@/components/project-secrets-settings";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Secrets",
};

export default async function SecretsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const secrets = await getSecrets(projectId);

  return <ProjectSecretsSettings projectId={projectId} initialEntries={secrets} />;
}
