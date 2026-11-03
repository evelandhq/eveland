import { ModelGatewaySettings } from "@/components/model-gateway-settings";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentMember, getModelGateway } from "@/lib/server-api";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Model Gateway",
};

export default async function ModelGatewaySettingsPage() {
  const member = await getCurrentMember();
  if (member.role !== "admin") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Model Gateway</CardTitle>
          <CardDescription>
            Only workspace administrators can configure where Agents send model calls.
          </CardDescription>
        </CardHeader>
        <CardContent>Ask an administrator to configure the Model Gateway.</CardContent>
      </Card>
    );
  }
  const gateway = await getModelGateway();

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Model Gateway</h2>
        <p className="text-sm text-muted-foreground">
          Route every Agent&apos;s string model IDs, such as anthropic/claude-sonnet-4.5, through
          one gateway. Agents keep their source unchanged; a provider an Agent installs itself is
          never replaced.
        </p>
      </div>
      <ModelGatewaySettings initialGateway={gateway} />
    </div>
  );
}
