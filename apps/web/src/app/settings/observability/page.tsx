import { ObservabilitySettings } from "@/components/observability/settings";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  getCurrentMember,
  getObservabilitySettings,
} from "@/lib/server-api";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Observability",
};

export default async function ObservabilitySettingsPage() {
  const member = await getCurrentMember();
  if (member.role !== "admin") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Observability</CardTitle>
          <CardDescription>
            Only workspace administrators can manage Eveland telemetry.
          </CardDescription>
        </CardHeader>
        <CardContent>
          Ask an administrator to update the Agent capture policy.
        </CardContent>
      </Card>
    );
  }

  const settings = await getObservabilitySettings();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">
          Observability
        </h2>
        <p className="text-sm text-muted-foreground">
          Control Eveland&apos;s private telemetry independently from
          instrumentation owned by Agent source code.
        </p>
      </div>
      <ObservabilitySettings initialSettings={settings} />
    </div>
  );
}
