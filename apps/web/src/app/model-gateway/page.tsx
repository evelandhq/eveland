import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ModelGatewayOverview } from "@/components/model-gateway-overview";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Model Gateway",
};

export default function ModelGatewayOverviewPage() {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 className="text-2xl font-semibold tracking-tight">Model Gateway</h2>
        <p className="text-sm text-muted-foreground">
          One model string per Agent — <code>model: &quot;zai/glm-5.3-flash&quot;</code> — resolved
          through the platform with your own provider keys. Agents never see a provider credential.
        </p>
      </header>
      <ModelGatewayOverview />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">How it works</CardTitle>
          <CardDescription>
            An administrator connects BYOK providers and routes canonical model ids to them. Every
            Deployment start mints an instance-bound gateway token; stopping the instance revokes
            it. Members can mint personal API keys for callers outside a Deployment.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Browse the routed catalog under{" "}
          <Link className="underline" href="/model-gateway/models">
            Models
          </Link>
          , manage credentials under{" "}
          <Link className="underline" href="/model-gateway/providers">
            Providers
          </Link>{" "}
          (administrators), and see per-model usage on the{" "}
          <Link className="underline" href="/usage">
            Usage
          </Link>{" "}
          page.
        </CardContent>
      </Card>
    </div>
  );
}
