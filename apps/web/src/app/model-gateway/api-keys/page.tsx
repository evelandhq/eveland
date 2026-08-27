import { ModelGatewayApiKeys } from "@/components/model-gateway-api-keys";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "API Keys",
};

export default function ModelGatewayApiKeysPage() {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 className="text-2xl font-semibold tracking-tight">API Keys</h2>
        <p className="text-sm text-muted-foreground">
          Personal keys for callers outside a Deployment. Deployments never need one — the Worker
          mints an instance-bound token for every process start.
        </p>
      </header>
      <ModelGatewayApiKeys />
    </div>
  );
}
