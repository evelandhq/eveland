import { ModelGatewayModels } from "@/components/model-gateway-models";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Models",
};

export default function ModelGatewayModelsPage() {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 className="text-2xl font-semibold tracking-tight">Models</h2>
        <p className="text-sm text-muted-foreground">
          The routed catalog. Copy a model id into <code>defineAgent(&#123; model &#125;)</code> —
          no provider import, no provider key.
        </p>
      </header>
      <ModelGatewayModels />
    </div>
  );
}
