import { PlatformSecretProfileSettings } from "@/components/platform-secret-profile-settings";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentMember, getPlatformSecretProfiles } from "@/lib/server-api";

export const dynamic = "force-dynamic";

export default async function SecretProfilesSettingsPage() {
  const member = await getCurrentMember();
  if (member.role !== "admin") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Secret profiles</CardTitle>
          <CardDescription>Only workspace administrators can manage operator-owned runtime values.</CardDescription>
        </CardHeader>
        <CardContent>Ask an administrator to create or update a Secret Profile.</CardContent>
      </Card>
    );
  }
  const profiles = await getPlatformSecretProfiles();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Secret profiles</h2>
        <p className="text-sm text-muted-foreground">
          Manage encrypted platform-owned values and bind them explicitly to Agent runtime or Connection consumers.
        </p>
      </div>
      <PlatformSecretProfileSettings initialProfiles={profiles} />
    </div>
  );
}
