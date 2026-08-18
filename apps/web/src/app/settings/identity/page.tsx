import { IdentitySettings } from "@/components/identity-settings";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getCurrentMember,
  getIdentityProviderSettings,
  getIdentityRealms,
  getIdentityReturnTargets,
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
        <CardContent>Ask an administrator to manage Identity Providers and Realms.</CardContent>
      </Card>
    );
  }

  const [providerSettings, realms, returnTargets] = await Promise.all([
    getIdentityProviderSettings(),
    getIdentityRealms(),
    getIdentityReturnTargets(),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold tracking-tight">Identity</h2>
        <p className="text-sm text-muted-foreground">Configure how people sign in to Agents.</p>
      </header>
      <IdentitySettings
        initialProviders={providerSettings.providers}
        initialRealms={realms}
        initialReturnTargets={returnTargets}
        oidcRedirectUri={providerSettings.oidcRedirectUri}
      />
    </div>
  );
}
