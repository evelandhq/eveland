"use client";

import { useId, useState } from "react";
import { PlusIcon, SaveIcon, Trash2Icon } from "lucide-react";
import type {
  AgentCapturePolicy,
  BuiltInOtlpActivity,
  ExternalDestinationConfig,
  ObservabilitySignal,
  PublicObservabilityPolicy,
  TelemetryDomain,
} from "@eveland/core/observability";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  createObservabilityDestination,
  deleteObservabilityDestination,
  saveObservabilitySettings,
  toggleObservabilityDestination,
} from "@/lib/client-api";

type DestinationKind = ExternalDestinationConfig["kind"];
type DestinationDraft = {
  kind: DestinationKind;
  endpoint: string;
  authorizationType: "bearer" | "api_key";
  credential: string;
  publicKey: string;
  secretKey: string;
  signals: Record<ObservabilitySignal, boolean>;
  domains: Record<TelemetryDomain, boolean>;
  headers: string;
};

const destinationKindItems = [
  { value: "elastic", label: "Elastic" },
  { value: "langfuse", label: "Langfuse" },
  { value: "custom_otlp", label: "Custom OTLP" },
] as const;

const emptyDestination = (): DestinationDraft => ({
  kind: "elastic",
  endpoint: "",
  authorizationType: "bearer",
  credential: "",
  publicKey: "",
  secretKey: "",
  signals: { traces: true, logs: true, metrics: true },
  domains: { agent: true, platform: true, runtime: true, capacity: true },
  headers: "{}",
});

export function ObservabilitySettings({
  initialSettings,
  initialActivity,
}: {
  initialSettings: PublicObservabilityPolicy;
  initialActivity: BuiltInOtlpActivity;
}) {
  const [settings, setSettings] = useState(initialSettings);
  const [capture, setCapture] = useState(initialSettings.agentCapture);
  const [pending, setPending] = useState(false);
  const [destinationDialogOpen, setDestinationDialogOpen] = useState(false);
  const [destinationDraft, setDestinationDraft] =
    useState<DestinationDraft>(emptyDestination);
  const [destinationError, setDestinationError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateCapture(patch: Partial<AgentCapturePolicy>) {
    setCapture((current) => ({ ...current, ...patch }));
    setSaved(false);
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setSaved(false);
    setError(null);
    try {
      const updated = await saveObservabilitySettings({
        expectedRevision: settings.revision,
        agentCapture: capture,
      });
      setSettings(updated);
      setCapture(updated.agentCapture);
      setSaved(true);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not update the observability policy.",
      );
    } finally {
      setPending(false);
    }
  }

  function openDestinationDialog() {
    setDestinationDraft(emptyDestination());
    setDestinationError(null);
    setDestinationDialogOpen(true);
  }

  async function createDestination(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setDestinationError(null);
    try {
      const updated = await createObservabilityDestination({
        expectedRevision: settings.revision,
        config: destinationConfig(destinationDraft),
      });
      setSettings(updated);
      setDestinationDialogOpen(false);
    } catch (caught) {
      setDestinationError(
        caught instanceof Error
          ? caught.message
          : "Could not configure the destination.",
      );
    } finally {
      setPending(false);
    }
  }

  async function toggleDestination(destinationId: string, enabled: boolean) {
    setPending(true);
    setError(null);
    try {
      setSettings(
        await toggleObservabilityDestination({
          destinationId,
          expectedRevision: settings.revision,
          enabled,
        }),
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not update the destination.",
      );
    } finally {
      setPending(false);
    }
  }

  async function deleteDestination(destinationId: string) {
    setPending(true);
    setError(null);
    try {
      setSettings(
        await deleteObservabilityDestination({
          destinationId,
          expectedRevision: settings.revision,
        }),
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not remove the destination.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Built-in</CardTitle>
          <CardDescription>
            Eveland&apos;s private OTLP destination for its own monitoring
            views.
          </CardDescription>
          <CardAction>
            <Badge variant="secondary">Always on</Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {settings.builtIn.signals.map((signal) => (
              <Badge key={signal} variant="outline">
                {signal}
              </Badge>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">
            {settings.builtIn.health.status === "healthy"
              ? `Receiving telemetry · last batch ${new Date(
                  settings.builtIn.health.lastReceivedAt!,
                ).toLocaleString()}`
              : "Waiting for the first telemetry batch."}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Collector delivery</CardTitle>
          <CardDescription>
            Standard Collector self-metrics for exporter queues and recent
            delivery attempts. Endpoint probes and actual pipeline delivery
            are reported independently.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {initialActivity.delivery.destinations.map((destination) => (
            <article
              key={destination.id}
              className="rounded-lg border border-border p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h4 className="font-medium">{destination.label}</h4>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">
                    {destination.exporterId}
                  </p>
                </div>
                <Badge
                  variant={
                    destination.status === "degraded" ||
                    destination.status === "stale"
                      ? "destructive"
                      : destination.status === "healthy"
                        ? "secondary"
                        : "outline"
                  }
                >
                  {collectorDeliveryStatusLabel(destination.status)}
                </Badge>
              </div>
              <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs text-muted-foreground">Queue size</dt>
                  <dd className="mt-1 font-mono font-medium">
                    {destination.queue.size === null
                      ? "—"
                      : destination.queue.size.toLocaleString()}
                    {destination.queue.capacity === null
                      ? ""
                      : ` / ${destination.queue.capacity.toLocaleString()}`}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    Queue utilization
                  </dt>
                  <dd className="mt-1 font-mono font-medium">
                    {destination.queue.utilization === null
                      ? "—"
                      : `${Math.round(destination.queue.utilization * 1000) / 10}%`}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    Last self-metric
                  </dt>
                  <dd className="mt-1 text-xs font-medium">
                    {destination.observedAt
                      ? new Date(destination.observedAt).toLocaleString()
                      : "Waiting for Collector metrics"}
                  </dd>
                </div>
              </dl>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="py-1.5 text-left font-medium">Signal</th>
                      <th className="py-1.5 text-right font-medium">
                        Sent
                      </th>
                      <th className="py-1.5 text-right font-medium">
                        Send failed
                      </th>
                      <th className="py-1.5 text-right font-medium">
                        Enqueue failed
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {destination.supportedSignals.map((signal) => (
                      <tr key={signal} className="border-t border-border">
                        <td className="py-2 font-medium">{signal}</td>
                        <td className="py-2 text-right font-mono">
                          {destination.signals[signal].sent.toLocaleString()}
                        </td>
                        <td className="py-2 text-right font-mono">
                          {destination.signals[
                            signal
                          ].sendFailed.toLocaleString()}
                        </td>
                        <td className="py-2 text-right font-mono">
                          {destination.signals[
                            signal
                          ].enqueueFailed.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Recent spans</CardTitle>
            <CardDescription>
              Latest traces received by Eveland&apos;s Built-in OTLP
              destination.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {initialActivity.spans.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No Eveland spans have been received yet.
              </p>
            ) : (
              <div className="divide-y">
                {initialActivity.spans.map((span) => (
                  <div
                    key={span.id}
                    className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="min-w-0 truncate text-sm font-medium">
                        {span.name}
                      </span>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        {formatDuration(span.durationMs)}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline">
                        {span.resource.serviceName}
                      </Badge>
                      <Badge variant="outline">
                        {span.resource.domain}
                      </Badge>
                      {span.statusCode === 2 ? (
                        <Badge variant="destructive">error</Badge>
                      ) : null}
                      <time
                        dateTime={span.startedAt}
                        className="text-xs text-muted-foreground"
                      >
                        {new Date(span.startedAt).toLocaleString()}
                      </time>
                    </div>
                    <p
                      className="truncate font-mono text-xs text-muted-foreground"
                      title={span.traceId}
                    >
                      trace {span.traceId}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent logs</CardTitle>
            <CardDescription>
              Latest standard LogRecords across Eveland services and
              runtimes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {initialActivity.logs.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No Eveland logs have been received yet.
              </p>
            ) : (
              <div className="divide-y">
                {initialActivity.logs.map((log) => (
                  <div
                    key={log.id}
                    className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="min-w-0 truncate text-sm font-medium">
                        {log.eventName ?? bodySummary(log.body)}
                      </span>
                      {log.severityText ? (
                        <Badge
                          variant={
                            (log.severityNumber ?? 0) >= 17
                              ? "destructive"
                              : "outline"
                          }
                        >
                          {log.severityText}
                        </Badge>
                      ) : null}
                    </div>
                    {log.eventName ? (
                      <p className="line-clamp-2 text-xs text-muted-foreground">
                        {bodySummary(log.body)}
                      </p>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline">
                        {log.resource.serviceName}
                      </Badge>
                      <Badge variant="outline">
                        {log.resource.domain}
                      </Badge>
                      <time
                        dateTime={log.timestamp}
                        className="text-xs text-muted-foreground"
                      >
                        {new Date(log.timestamp).toLocaleString()}
                      </time>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent metrics</CardTitle>
            <CardDescription>
              Latest standard Metric Points across Eveland services and
              telemetry domains.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {initialActivity.metrics.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No Eveland metrics have been received yet.
              </p>
            ) : (
              <div className="divide-y">
                {initialActivity.metrics.map((metric) => (
                  <div
                    key={metric.id}
                    className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span
                        className="min-w-0 truncate text-sm font-medium"
                        title={metric.name}
                      >
                        {metric.name}
                      </span>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        {metricValueSummary(metric)}
                      </span>
                    </div>
                    {attributeSummary(metric.attributes) ? (
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {attributeSummary(metric.attributes)}
                      </p>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline">
                        {metric.resource.serviceName}
                      </Badge>
                      <Badge variant="outline">
                        {metric.resource.domain}
                      </Badge>
                      <Badge variant="outline">
                        {metric.dataType}
                      </Badge>
                      <time
                        dateTime={metric.timestamp}
                        className="text-xs text-muted-foreground"
                      >
                        {new Date(metric.timestamp).toLocaleString()}
                      </time>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>External destinations</CardTitle>
          <CardDescription>
            Forward Eveland telemetry through the managed OpenTelemetry
            Collector. Elastic receives every signal and domain; Langfuse
            receives Agent traces only.
          </CardDescription>
          <CardAction>
            <Button
              type="button"
              size="sm"
              onClick={openDestinationDialog}
              disabled={pending}
            >
              <PlusIcon data-icon="inline-start" />
              Add destination
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {settings.externalDestinations.length === 0 ? (
            <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
              No external destination is configured. Built-in monitoring
              continues to receive all Eveland telemetry.
            </div>
          ) : (
            settings.externalDestinations.map((destination) => (
              <div
                key={destination.id}
                className="flex flex-col gap-4 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">
                      {destinationKindLabel(destination.kind)}
                    </span>
                    <Badge
                      variant={destination.enabled ? "secondary" : "outline"}
                    >
                      {destination.enabled ? "Enabled" : "Paused"}
                    </Badge>
                    <Badge
                      variant={
                        destination.health.status === "degraded"
                          ? "destructive"
                          : "outline"
                      }
                    >
                      {destination.health.status === "pending"
                        ? "Probe pending"
                        : destination.health.status === "healthy"
                          ? "Healthy"
                          : destination.health.status === "degraded"
                            ? "Degraded"
                            : "Probe paused"}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {destination.supportedSignals.map((signal) => (
                      <Badge key={signal} variant="outline">
                        {signal}
                      </Badge>
                    ))}
                    {"domains" in destination
                      ? destination.domains.map((domain) => (
                          <Badge key={domain} variant="outline">
                            {domain}
                          </Badge>
                        ))
                      : null}
                    {destination.kind === "langfuse" ? (
                      <Badge variant="outline">agent</Badge>
                    ) : null}
                  </div>
                  {destination.health.lastError ? (
                    <p className="text-xs text-destructive">
                      {destination.health.lastError}
                    </p>
                  ) : destination.health.checkedAt ? (
                    <p className="text-xs text-muted-foreground">
                      Last checked{" "}
                      {new Date(
                        destination.health.checkedAt,
                      ).toLocaleString()}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Switch
                    aria-label={`Enable ${destinationKindLabel(destination.kind)}`}
                    checked={destination.enabled}
                    disabled={pending}
                    onCheckedChange={(enabled) =>
                      void toggleDestination(destination.id, enabled)
                    }
                  />
                  <AlertDialog>
                    <AlertDialogTrigger
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove ${destinationKindLabel(destination.kind)}`}
                          disabled={pending}
                        />
                      }
                    >
                      <Trash2Icon />
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          Remove {destinationKindLabel(destination.kind)}?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          Eveland will stop forwarding telemetry to this
                          destination. Built-in monitoring is unaffected.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() =>
                            void deleteDestination(destination.id)
                          }
                        >
                          Remove destination
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
            ))
          )}
          <p className="text-xs text-muted-foreground">
            Credentials are encrypted at rest and are never returned to the
            browser after saving. Changes are applied without restarting Agent
            Deployments.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Agent capture</CardTitle>
          <CardDescription>
            Controls only telemetry injected by Eveland. User instrumentation
            remains unchanged and continues to use its own providers and
            exporters.
          </CardDescription>
        </CardHeader>
        <form onSubmit={save}>
          <CardContent className="flex flex-col gap-5">
            <FieldGroup>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldTitle>Capture Agent telemetry</FieldTitle>
                  <FieldDescription>
                    Turn Eveland&apos;s private Agent traces, logs, and metrics
                    on or off.
                  </FieldDescription>
                </FieldContent>
                <Switch
                  aria-label="Capture Agent telemetry"
                  checked={capture.enabled}
                  onCheckedChange={(enabled) => updateCapture({ enabled })}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="agent-sampling-ratio">
                  Trace sampling
                </FieldLabel>
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
                      updateCapture({
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
                  Applies to Eveland-injected root Agent spans. Child spans keep
                  the parent sampling decision.
                </FieldDescription>
              </Field>

              <CaptureSwitch
                title="Record inputs"
                description="Attach Agent input content to Eveland telemetry."
                checked={capture.recordInputs}
                disabled={!capture.enabled}
                onCheckedChange={(recordInputs) =>
                  updateCapture({ recordInputs })
                }
              />
              <CaptureSwitch
                title="Record outputs"
                description="Attach Agent output content to Eveland telemetry."
                checked={capture.recordOutputs}
                disabled={!capture.enabled}
                onCheckedChange={(recordOutputs) =>
                  updateCapture({ recordOutputs })
                }
              />
              <CaptureSwitch
                title="Include reasoning"
                description="Allow reasoning content in Eveland telemetry when Eve exposes it."
                checked={capture.includeReasoning}
                disabled={!capture.enabled}
                onCheckedChange={(includeReasoning) =>
                  updateCapture({ includeReasoning })
                }
              />
            </FieldGroup>

            {saved ? (
              <Alert>
                <AlertDescription>
                  Policy saved. Running Agents will reload it without a
                  restart.
                </AlertDescription>
              </Alert>
            ) : null}
          </CardContent>
          <CardFooter className="mt-6 border-t">
            <Button type="submit" disabled={pending}>
              {pending ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <SaveIcon data-icon="inline-start" />
              )}
              {pending ? "Saving…" : "Save policy"}
            </Button>
          </CardFooter>
        </form>
      </Card>

      <DestinationDialog
        open={destinationDialogOpen}
        draft={destinationDraft}
        pending={pending}
        error={destinationError}
        onOpenChange={(open) => {
          if (!pending) setDestinationDialogOpen(open);
        }}
        onDraftChange={(patch) =>
          setDestinationDraft((current) => ({ ...current, ...patch }))
        }
        onSubmit={createDestination}
      />
    </div>
  );
}

function formatDuration(durationMs: number): string {
  return durationMs < 1_000
    ? `${Math.round(durationMs * 100) / 100} ms`
    : `${Math.round(durationMs / 10) / 100} s`;
}

function bodySummary(body: unknown): string {
  const value =
    typeof body === "string" ? body : JSON.stringify(body) ?? "";
  return value.length > 240 ? `${value.slice(0, 237)}...` : value;
}

function metricValueSummary(
  metric: BuiltInOtlpActivity["metrics"][number],
): string {
  const direct = metric.value.asDouble ?? metric.value.asInt;
  if (typeof direct === "number" || typeof direct === "string") {
    return `${formatMetricNumber(direct)}${metric.unit ? ` ${metric.unit}` : ""}`;
  }
  const count = metric.value.count;
  const sum = metric.value.sum;
  if (
    typeof count === "number" &&
    count > 0 &&
    typeof sum === "number"
  ) {
    return `avg ${formatMetricNumber(sum / count)}${metric.unit ? ` ${metric.unit}` : ""}`;
  }
  if (typeof count === "number" || typeof count === "string") {
    return `count ${formatMetricNumber(count)}`;
  }
  return metric.dataType;
}

function formatMetricNumber(value: number | string): string {
  return typeof value === "number"
    ? value.toLocaleString(undefined, {
        maximumFractionDigits: 2,
      })
    : value;
}

function attributeSummary(
  attributes: Record<string, unknown>,
): string {
  return Object.entries(attributes)
    .slice(0, 3)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" · ");
}

function collectorDeliveryStatusLabel(
  status: BuiltInOtlpActivity["delivery"]["destinations"][number]["status"],
): string {
  return status === "healthy"
    ? "Delivering"
    : status === "degraded"
      ? "Delivery degraded"
      : status === "stale"
        ? "Collector metrics stale"
        : "Waiting for Collector metrics";
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

function DestinationDialog({
  open,
  draft,
  pending,
  error,
  onOpenChange,
  onDraftChange,
  onSubmit,
}: {
  open: boolean;
  draft: DestinationDraft;
  pending: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onDraftChange: (patch: Partial<DestinationDraft>) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
  const kindId = useId();
  const endpointId = useId();
  const authTypeId = useId();
  const credentialId = useId();
  const publicKeyId = useId();
  const secretKeyId = useId();
  const headersId = useId();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add external destination</DialogTitle>
          <DialogDescription>
            The managed Collector applies a separate filter, retry queue, and
            exporter for this destination.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={kindId}>Product</FieldLabel>
              <Select
                items={destinationKindItems}
                value={draft.kind}
                onValueChange={(kind) => {
                  if (kind) onDraftChange({ kind });
                }}
              >
                <SelectTrigger id={kindId}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {destinationKindItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                {draft.kind === "elastic"
                  ? "Elastic receives traces, logs, and metrics from every Eveland domain."
                  : draft.kind === "langfuse"
                    ? "Langfuse receives only Eveland-injected Agent and GenAI traces."
                    : "Choose which Eveland signals and domains reach this OTLP/HTTP endpoint."}
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor={endpointId}>
                {draft.kind === "langfuse"
                  ? "OTLP traces endpoint"
                  : "OTLP endpoint"}
              </FieldLabel>
              <Input
                id={endpointId}
                type="url"
                value={draft.endpoint}
                placeholder={
                  draft.kind === "langfuse"
                    ? "https://cloud.langfuse.com/api/public/otel/v1/traces"
                    : "https://observability.example.com:4318"
                }
                onChange={(event) =>
                  onDraftChange({ endpoint: event.currentTarget.value })
                }
                required
              />
            </Field>

            {draft.kind === "elastic" ? (
              <>
                <Field>
                  <FieldLabel htmlFor={authTypeId}>
                    Authorization type
                  </FieldLabel>
                  <Select
                    items={[
                      { value: "bearer", label: "Bearer token" },
                      { value: "api_key", label: "API key" },
                    ]}
                    value={draft.authorizationType}
                    onValueChange={(authorizationType) => {
                      if (authorizationType) {
                        onDraftChange({ authorizationType });
                      }
                    }}
                  >
                    <SelectTrigger id={authTypeId}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="bearer">Bearer token</SelectItem>
                      <SelectItem value="api_key">API key</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor={credentialId}>Credential</FieldLabel>
                  <Input
                    id={credentialId}
                    type="password"
                    autoComplete="new-password"
                    value={draft.credential}
                    onChange={(event) =>
                      onDraftChange({
                        credential: event.currentTarget.value,
                      })
                    }
                    required
                  />
                </Field>
              </>
            ) : null}

            {draft.kind === "langfuse" ? (
              <>
                <Field>
                  <FieldLabel htmlFor={publicKeyId}>Public key</FieldLabel>
                  <Input
                    id={publicKeyId}
                    value={draft.publicKey}
                    autoComplete="off"
                    onChange={(event) =>
                      onDraftChange({ publicKey: event.currentTarget.value })
                    }
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={secretKeyId}>Secret key</FieldLabel>
                  <Input
                    id={secretKeyId}
                    type="password"
                    autoComplete="new-password"
                    value={draft.secretKey}
                    onChange={(event) =>
                      onDraftChange({ secretKey: event.currentTarget.value })
                    }
                    required
                  />
                </Field>
              </>
            ) : null}

            {draft.kind === "custom_otlp" ? (
              <>
                <Field>
                  <FieldLabel>Signals</FieldLabel>
                  <div className="grid gap-3 sm:grid-cols-3">
                    {(["traces", "logs", "metrics"] as const).map((signal) => (
                      <OptionSwitch
                        key={signal}
                        label={signal}
                        checked={draft.signals[signal]}
                        onCheckedChange={(checked) =>
                          onDraftChange({
                            signals: { ...draft.signals, [signal]: checked },
                          })
                        }
                      />
                    ))}
                  </div>
                </Field>
                <Field>
                  <FieldLabel>Domains</FieldLabel>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {(
                      ["agent", "platform", "runtime", "capacity"] as const
                    ).map((domain) => (
                      <OptionSwitch
                        key={domain}
                        label={domain}
                        checked={draft.domains[domain]}
                        onCheckedChange={(checked) =>
                          onDraftChange({
                            domains: { ...draft.domains, [domain]: checked },
                          })
                        }
                      />
                    ))}
                  </div>
                </Field>
                <Field>
                  <FieldLabel htmlFor={headersId}>Headers (JSON)</FieldLabel>
                  <Input
                    id={headersId}
                    value={draft.headers}
                    placeholder='{"authorization":"Bearer ..."}'
                    onChange={(event) =>
                      onDraftChange({ headers: event.currentTarget.value })
                    }
                    required
                  />
                  <FieldDescription>
                    Header values are encrypted with the destination
                    configuration.
                  </FieldDescription>
                </Field>
              </>
            ) : null}

            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <Spinner data-icon="inline-start" /> : null}
              {pending ? "Saving…" : "Add destination"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function OptionSwitch({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
      <span className="text-sm capitalize">{label}</span>
      <Switch
        aria-label={label}
        checked={checked}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}

function destinationKindLabel(kind: DestinationKind): string {
  return (
    destinationKindItems.find((item) => item.value === kind)?.label ??
    "Custom OTLP"
  );
}

function destinationConfig(draft: DestinationDraft): ExternalDestinationConfig {
  if (draft.kind === "elastic") {
    return {
      kind: "elastic",
      endpoint: draft.endpoint,
      authorization: {
        type: draft.authorizationType,
        value: draft.credential,
      },
    };
  }
  if (draft.kind === "langfuse") {
    return {
      kind: "langfuse",
      tracesEndpoint: draft.endpoint,
      publicKey: draft.publicKey,
      secretKey: draft.secretKey,
    };
  }

  const headers: unknown = JSON.parse(draft.headers);
  if (
    !headers ||
    typeof headers !== "object" ||
    Array.isArray(headers) ||
    Object.values(headers).some((value) => typeof value !== "string")
  ) {
    throw new Error("Headers must be a JSON object with string values.");
  }
  const supportedSignals = (
    Object.entries(draft.signals) as [ObservabilitySignal, boolean][]
  )
    .filter(([, enabled]) => enabled)
    .map(([signal]) => signal);
  const domains = (
    Object.entries(draft.domains) as [TelemetryDomain, boolean][]
  )
    .filter(([, enabled]) => enabled)
    .map(([domain]) => domain);
  if (supportedSignals.length === 0 || domains.length === 0) {
    throw new Error("Select at least one signal and one telemetry domain.");
  }
  return {
    kind: "custom_otlp",
    endpoint: draft.endpoint,
    supportedSignals,
    domains,
    headers: headers as Record<string, string>,
  };
}
