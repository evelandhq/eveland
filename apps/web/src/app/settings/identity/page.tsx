import { IdentitySettings } from "@/components/identity-settings";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  getCurrentMember,
  getIdentityProviders,
  getIdentityRealmGrants,
  getIdentityRealms,
  getIdentityReturnTargets,
  getProjects,
} from "@/lib/server-api";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Identity",
};

export default async function IdentitySettingsPage() {
  const member = await getCurrentMember();
  if (member.role !== "admin") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Identity</CardTitle>
          <CardDescription>
            Only workspace administrators can configure Agent-user identity.
          </CardDescription>
        </CardHeader>
        <CardContent>
          Ask an administrator to manage Identity Providers, Realms, and Project access.
        </CardContent>
      </Card>
    );
  }

  const [providers, realms, projects, returnTargets] = await Promise.all([
    getIdentityProviders(),
    getIdentityRealms(),
    getProjects(),
    getIdentityReturnTargets(),
  ]);
  const grants = (
    await Promise.all(
      realms.map((realm) => getIdentityRealmGrants(realm.id)),
    )
  ).flat();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold tracking-tight">Identity</h2>
        <p className="text-sm text-muted-foreground">
          Configure how people sign in to Agents and which Projects each identity scope can use.
        </p>
      </header>
      <IdentitySettings
        initialProviders={providers}
        initialRealms={realms}
        initialGrants={grants}
        initialReturnTargets={returnTargets}
        projects={projects.map((project) => ({
          id: project.id,
          name: project.name,
        }))}
      />
    </div>
  );
}
