"use client";

import { useId } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
  FieldDescription,
  FieldGroup,
  FieldLabel,
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
  destinationKindItems,
  destinationKindLabel,
  type DestinationDraft,
  type DestinationEditor,
} from "./destination-draft";

export function ObservabilityDestinationDialog({
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
