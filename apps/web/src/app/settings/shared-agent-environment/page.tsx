import { SharedAgentEnvironmentSettings } from "@/components/shared-agent-environment-settings";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentMember, getSharedAgentEnvironment } from "@/lib/server-api";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Environment",
};

export default async function SharedAgentEnvironmentSettingsPage() {
  const member = await getCurrentMember();
  if (member.role !== "admin") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Environment</CardTitle>
          <CardDescription>
            Only workspace administrators can manage shared runtime defaults.
          </CardDescription>
        </CardHeader>
        <CardContent>
          Ask an administrator to configure or rotate the shared Agent environment.
        </CardContent>
      </Card>
    );
  }
  const environment = await getSharedAgentEnvironment();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Environment</h2>
        <p className="text-sm text-muted-foreground">
          Maintain one encrypted set of fallback runtime values applied automatically to every Agent
          Deployment.
        </p>
      </div>
      <SharedAgentEnvironmentSettings initialEnvironment={environment} />
    </div>
  );
}
