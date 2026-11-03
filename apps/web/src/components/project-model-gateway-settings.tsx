"use client";

import { useId, useState } from "react";
import { AlertTriangleIcon, CheckCircle2Icon } from "lucide-react";
import type { ProjectModelGatewayMode } from "@evelandhq/core/model-gateway";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { saveProjectModelGateway } from "@/lib/client-api";
import {
  modelGatewayRebuildNotice,
  projectModelGatewayModeOptions,
  projectModelGatewaySummary,
  type ProjectModelGatewayResponse,
} from "@/lib/model-gateway";

const modeItems = projectModelGatewayModeOptions.map(({ label, value }) => ({ label, value }));

export function ProjectModelGatewaySettings({
  projectId,
  initial,
}: {
  projectId: string;
  initial: ProjectModelGatewayResponse;
}) {
  const modeId = useId();
  const [settings, setSettings] = useState(initial.settings);
  const [mode, setMode] = useState<ProjectModelGatewayMode>(initial.settings.mode);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rebuildRequired, setRebuildRequired] = useState(initial.rebuildRequired);
  const rebuildNotice = modelGatewayRebuildNotice(rebuildRequired, "project");
  const gateway = initial.gateway;
  const modeOption = projectModelGatewayModeOptions.find((option) => option.value === mode)!;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const result = await saveProjectModelGateway(projectId, { mode });
      setSettings(result.settings);
      setRebuildRequired(result.rebuildRequired);
      setNotice(
        result.jobs.length > 0
          ? `Saved. ${result.jobs.length} live deployment restart${result.jobs.length === 1 ? "" : "s"} queued.`
          : "Saved. Deployments use it the next time their process starts.",
      );
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not save the Model Gateway setting.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="project-model-gateway-heading" className="flex flex-col gap-5">
      <div>
        <h3 id="project-model-gateway-heading" className="text-base font-semibold">
          Model Gateway
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {projectModelGatewaySummary(settings, gateway)}
        </p>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert>
          <CheckCircle2Icon />
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      {rebuildNotice ? (
        <Alert>
          <AlertTriangleIcon />
          <AlertDescription>{rebuildNotice}</AlertDescription>
        </Alert>
      ) : null}

      {gateway !== null ? (
        <form className="flex flex-col gap-5" onSubmit={save}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={modeId}>String model IDs</FieldLabel>
              <Select
                items={modeItems}
                value={mode}
                onValueChange={(value) => {
                  const next = projectModelGatewayModeOptions.find(
                    (option) => option.value === value,
                  );
                  if (next) {
                    setMode(next.value);
                    setError(null);
                    setNotice(null);
                  }
                }}
                disabled={pending}
              >
                <SelectTrigger id={modeId} className="w-full sm:w-72">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectGroup>
                    {modeItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                {modeOption.description} Set the key as a secret under Variables and secrets;
                without one, model calls fail at the gateway.
              </FieldDescription>
            </Field>
          </FieldGroup>

          <div>
            <Button type="submit" disabled={pending}>
              {pending ? <Spinner data-icon="inline-start" /> : null}
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
