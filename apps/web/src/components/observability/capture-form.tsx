"use client";

import { SaveIcon } from "lucide-react";
import type { AgentCapturePolicy } from "@eveland/core/observability";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";

export function ObservabilityCaptureForm({
  capture,
  pending,
  saved,
  onChange,
  onSubmit,
}: {
  capture: AgentCapturePolicy;
  pending: boolean;
  saved: boolean;
  onChange: (patch: Partial<AgentCapturePolicy>) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Agent capture</CardTitle>
        <CardDescription>
          Controls only telemetry injected by Eveland. User instrumentation remains unchanged and
          continues to use its own providers and exporters.
        </CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit}>
        <CardContent className="flex flex-col gap-5">
          <FieldGroup>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldTitle>Capture Agent telemetry</FieldTitle>
                <FieldDescription>
                  Turn Eveland&apos;s private Agent traces, logs, and metrics on or off.
                </FieldDescription>
              </FieldContent>
              <Switch
                aria-label="Capture Agent telemetry"
                checked={capture.enabled}
                onCheckedChange={(enabled) => onChange({ enabled })}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="agent-sampling-ratio">Trace sampling</FieldLabel>
              <div className="flex items-center gap-3">
                <Input
                  id="agent-sampling-ratio"
                  className="max-w-32"
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={Math.round(capture.sampling.ratio * 100)}
                  onChange={(event) =>
                    onChange({
                      sampling: {
                        ratio: Number(event.currentTarget.value) / 100,
                      },
                    })
                  }
                  disabled={!capture.enabled}
                  required
                />
                <span className="text-sm text-muted-foreground">%</span>
              </div>
              <FieldDescription>
                Applies to Eveland-injected root Agent spans. Child spans keep the parent sampling
                decision.
              </FieldDescription>
            </Field>

            <CaptureSwitch
              title="Record inputs"
              description="Attach Agent input content to Eveland telemetry."
              checked={capture.recordInputs}
              disabled={!capture.enabled}
              onCheckedChange={(recordInputs) => onChange({ recordInputs })}
            />
            <CaptureSwitch
              title="Record outputs"
              description="Attach Agent output content — assistant text, reasoning, and tool results — to Eveland telemetry."
              checked={capture.recordOutputs}
              disabled={!capture.enabled}
              onCheckedChange={(recordOutputs) => onChange({ recordOutputs })}
            />
          </FieldGroup>

          {saved ? (
            <Alert>
              <AlertDescription>
                Policy saved. Running Agents will reload it without a restart.
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
        <CardFooter className="mt-6 border-t">
          <Button type="submit" disabled={pending}>
            {pending ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}
            {pending ? "Saving…" : "Save policy"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

function CaptureSwitch({
  title,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <Field orientation="horizontal" data-disabled={disabled || undefined}>
      <FieldContent>
        <FieldTitle>{title}</FieldTitle>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
      <Switch
        aria-label={title}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </Field>
  );
}
