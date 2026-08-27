import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ModelGatewayProviders } from "@/components/model-gateway-providers";
import { getCurrentMember } from "@/lib/server-api";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Providers",
};

export default async function ModelGatewayProvidersPage() {
  const member = await getCurrentMember();
  if (member.role !== "admin") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Providers</CardTitle>
          <CardDescription>
            Only workspace administrators can manage BYOK provider credentials.
          </CardDescription>
        </CardHeader>
        <CardContent>Ask an administrator to connect providers and route models.</CardContent>
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 className="text-2xl font-semibold tracking-tight">Providers</h2>
        <p className="text-sm text-muted-foreground">
          BYOK connections the Model Gateway replays requests with. Credentials are verified on
          save, encrypted at rest, and never reach an Agent process.
        </p>
      </header>
      <ModelGatewayProviders />
    </div>
  );
}
