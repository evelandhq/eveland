"use client";

import { useId, useState } from "react";
import { PencilIcon, PlusIcon, SaveIcon, Trash2Icon } from "lucide-react";
import {
  TELEMETRY_DOMAINS,
  type AgentCapturePolicy,
  type ExternalDestinationConfigPatch,
  type ObservabilitySignal,
  type PublicExternalObservabilityDestination,
  type PublicObservabilityPolicy,
  type TelemetryDomain,
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
  updateObservabilityDestination,
} from "@/lib/client-api";

type Destination = PublicExternalObservabilityDestination;
type DestinationKind = ExternalDestinationConfigPatch["kind"];
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
/**
 * Editing never receives the stored credentials back, so the draft starts them empty and
 * an empty field is submitted as "keep what is stored". That is only possible while the
 * stored configuration can still be opened, so `storedCredentials` is null both when
 * creating and when the configuration is unreadable — in both cases the Admin must supply
 * the credential.
 */
type DestinationEditor = {
  destinationId: string | null;
  draft: DestinationDraft;
  storedCredentials: { headerNames: string[] } | null;
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
}: {
  initialSettings: PublicObservabilityPolicy;
}) {
  const [settings, setSettings] = useState(initialSettings);
  const [capture, setCapture] = useState(initialSettings.agentCapture);
  const [pending, setPending] = useState(false);
  const [editor, setEditor] = useState<DestinationEditor | null>(null);
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

  function openCreateDialog() {
    setDestinationError(null);
    setEditor({
      destinationId: null,
      draft: emptyDestination(),
      storedCredentials: null,
    });
  }

  function openEditDialog(destination: Destination) {
    setDestinationError(null);
    setEditor({
      destinationId: destination.id,
      draft: draftFromDestination(destination),
      storedCredentials: destination.config
        ? {
            headerNames:
              destination.config.kind === "custom_otlp"
                ? destination.config.headerNames
                : [],
          }
        : null,
    });
  }

  async function submitDestination(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor) return;
    setPending(true);
    setDestinationError(null);
    try {
      const config = destinationPatch(editor.draft);
      setSettings(
        editor.destinationId === null
          ? await createObservabilityDestination({
              expectedRevision: settings.revision,
              config,
            })
          : await updateObservabilityDestination({
              destinationId: editor.destinationId,
              expectedRevision: settings.revision,
              config,
            }),
      );
      setEditor(null);
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
              onClick={openCreateDialog}
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
              No external destination is configured. Until one is added, span,
              log, and metric detail is not retained anywhere.
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
                  <DestinationEndpoint destination={destination} />
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
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Edit ${destinationKindLabel(destination.kind)}`}
                    disabled={pending}
                    onClick={() => openEditDialog(destination)}
                  >
                    <PencilIcon />
                  </Button>
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
                          destination and its stored credentials are deleted.
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

      {editor ? (
        <DestinationDialog
          editor={editor}
          pending={pending}
          error={destinationError}
          onOpenChange={(open) => {
            if (!pending && !open) setEditor(null);
          }}
          onDraftChange={(patch) =>
            setEditor((current) =>
              current
                ? { ...current, draft: { ...current.draft, ...patch } }
                : current,
            )
          }
          onSubmit={submitDestination}
        />
      ) : null}
    </div>
  );
}

function DestinationEndpoint({ destination }: { destination: Destination }) {
  if (!destination.config) {
    return (
      <p className="text-xs text-destructive">
        The stored configuration cannot be read with the current
        APP_SECRET_KEY. Edit the destination to replace it.
      </p>
    );
  }
  return (
    <span className="break-all font-mono text-xs">
      {destination.config.kind === "langfuse"
        ? destination.config.baseUrl
        : destination.config.endpoint}
    </span>
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

function DestinationDialog({
  editor,
  pending,
  error,
  onOpenChange,
  onDraftChange,
  onSubmit,
}: {
  editor: DestinationEditor;
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
  const { draft, storedCredentials } = editor;
  const editing = editor.destinationId !== null;
  const keepStored = "Leave blank to keep the stored value.";

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {editing
              ? `Edit ${destinationKindLabel(draft.kind)}`
              : "Add external destination"}
          </DialogTitle>
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
                disabled={editing}
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
                  ? "Langfuse base URL"
                  : "OTLP endpoint"}
              </FieldLabel>
              <Input
                id={endpointId}
                type="url"
                value={draft.endpoint}
                placeholder={
                  draft.kind === "langfuse"
                    ? "https://us.cloud.langfuse.com"
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
                    required={storedCredentials === null}
                  />
                  {storedCredentials ? (
                    <FieldDescription>{keepStored}</FieldDescription>
                  ) : null}
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
                    required={storedCredentials === null}
                  />
                  {storedCredentials ? (
                    <FieldDescription>{keepStored}</FieldDescription>
                  ) : null}
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
                    required={storedCredentials === null}
                  />
                  {storedCredentials ? (
                    <FieldDescription>{keepStored}</FieldDescription>
                  ) : null}
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
                    required={storedCredentials === null}
                  />
                  <FieldDescription>
                    Header values are encrypted with the destination
                    configuration.
                    {storedCredentials
                      ? ` ${keepStored}${
                          storedCredentials.headerNames.length > 0
                            ? ` Configured: ${storedCredentials.headerNames.join(", ")}.`
                            : ""
                        }`
                      : ""}
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
              {pending
                ? "Saving…"
                : editing
                  ? "Save changes"
                  : "Add destination"}
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

function draftFromDestination(destination: Destination): DestinationDraft {
  const config = destination.config;
  const signals: readonly ObservabilitySignal[] = destination.supportedSignals;
  const domains: readonly TelemetryDomain[] =
    "domains" in destination ? destination.domains : TELEMETRY_DOMAINS;
  return {
    kind: destination.kind,
    endpoint: config
      ? config.kind === "langfuse"
        ? config.baseUrl
        : config.endpoint
      : "",
    authorizationType:
      config?.kind === "elastic" ? config.authorization.type : "bearer",
    credential: "",
    publicKey: "",
    secretKey: "",
    signals: {
      traces: signals.includes("traces"),
      logs: signals.includes("logs"),
      metrics: signals.includes("metrics"),
    },
    domains: {
      agent: domains.includes("agent"),
      platform: domains.includes("platform"),
      runtime: domains.includes("runtime"),
      capacity: domains.includes("capacity"),
    },
    headers: "",
  };
}

/**
 * Empty credential fields are omitted rather than sent as empty strings, which is how the
 * API distinguishes "keep the stored credential" from an invalid one.
 */
function destinationPatch(
  draft: DestinationDraft,
): ExternalDestinationConfigPatch {
  if (draft.kind === "elastic") {
    return {
      kind: "elastic",
      endpoint: draft.endpoint,
      authorization: {
        type: draft.authorizationType,
        ...(draft.credential ? { value: draft.credential } : {}),
      },
    };
  }
  if (draft.kind === "langfuse") {
    return {
      kind: "langfuse",
      baseUrl: draft.endpoint,
      ...(draft.publicKey ? { publicKey: draft.publicKey } : {}),
      ...(draft.secretKey ? { secretKey: draft.secretKey } : {}),
    };
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
    ...(draft.headers.trim() ? { headers: parseHeaders(draft.headers) } : {}),
  };
}

function parseHeaders(input: string): Record<string, string> {
  const headers: unknown = JSON.parse(input);
  if (
    !headers ||
    typeof headers !== "object" ||
    Array.isArray(headers) ||
    Object.values(headers).some((value) => typeof value !== "string")
  ) {
    throw new Error("Headers must be a JSON object with string values.");
  }
  return headers as Record<string, string>;
}
