import { GitCredentialsSettings } from "@/components/git-credentials-settings";
import { getGitCredentials } from "@/lib/server-api";

export const metadata = {
  title: "Git credentials",
};

export default async function GitCredentialsSettingsPage() {
  const credentials = await getGitCredentials();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-[17px] font-semibold tracking-tight">Git credentials</h2>
        <p className="text-sm text-muted-foreground">
          Manage personal credentials reused for private repository imports.
        </p>
      </div>
      <GitCredentialsSettings initialCredentials={credentials} />
    </div>
  );
}
