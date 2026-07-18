import { getSecrets } from "@/lib/server-api";
import { SecretForm } from "@/components/secret-form";

export const dynamic = "force-dynamic";

export default async function SecretsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const secrets = await getSecrets(projectId);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <section className="rounded-md border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">Secrets</h2>
            <p className="mt-1 text-xs text-muted-foreground">Values are encrypted by the API and never returned to the browser.</p>
          </div>
          <table className="w-full border-collapse text-sm">
            <tbody>
              {secrets.length === 0 ? (
                <tr>
                  <td className="px-4 py-10 text-center text-muted-foreground">No secrets configured.</td>
                </tr>
              ) : (
                secrets.map((secret) => (
                  <tr key={secret.id} className="border-t border-border">
                    <td className="px-4 py-3 font-medium">{secret.key}</td>
                    <td className="px-4 py-3 text-right text-xs text-muted-foreground">Updated {new Date(secret.updatedAt).toLocaleString()}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>
        <SecretForm projectId={projectId} />
      </div>
    </div>
  );
}
