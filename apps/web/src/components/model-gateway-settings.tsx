"use client";

import { useId, useState } from "react";
import { CheckCircle2Icon, Trash2Icon } from "lucide-react";
import type { ModelGateway, ModelGatewayKind } from "@evelandhq/core/model-gateway";
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
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
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
import { deleteModelGateway, saveModelGateway } from "@/lib/client-api";
import {
  modelGatewayKindOption,
  modelGatewayKindOptions,
  validateModelGatewayDraft,
  type ModelGatewayInput,
} from "@/lib/model-gateway";

const kindItems = modelGatewayKindOptions.map(({ label, value }) => ({ label, value }));

function draftFrom(gateway: ModelGateway | null): ModelGatewayInput {
  return { kind: gateway?.kind ?? "litellm", baseUrl: gateway?.baseUrl ?? "" };
}

function restartNotice(prefix: string, jobs: readonly unknown[]): string {
  return jobs.length > 0
    ? `${prefix} ${jobs.length} live deployment restart${jobs.length === 1 ? "" : "s"} queued.`
    : `${prefix} Agent Deployments use it the next time their process starts.`;
}

export function ModelGatewaySettings({ initialGateway }: { initialGateway: ModelGateway | null }) {
  const kindId = useId();
  const baseUrlId = useId();
  const [gateway, setGateway] = useState(initialGateway);
  const [draft, setDraft] = useState<ModelGatewayInput>(() => draftFrom(initialGateway));
  const [pending, setPending] = useState<"save" | "remove" | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const option = modelGatewayKindOption(draft.kind);

  function update(patch: Partial<ModelGatewayInput>) {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
    setNotice(null);
  }

  async function save() {
    const validated = validateModelGatewayDraft(draft);
    if (!validated.ok) {
      setError(validated.error);
      return;
    }
    setPending("save");
    setError(null);
    setNotice(null);
    try {
      const result = await saveModelGateway(validated.input);
      setGateway(result.gateway);
      setDraft(draftFrom(result.gateway));
      setNotice(restartNotice("Model Gateway saved.", result.jobs));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not reach the Eveland API.");
    } finally {
      setPending(null);
    }
  }

  async function remove(event: React.FormEvent) {
    event.preventDefault();
    // The dialog renders in a portal, but React still bubbles its submit
    // through the component tree into the surrounding gateway form.
    event.stopPropagation();
    setPending("remove");
    setError(null);
    setNotice(null);
    try {
      const result = await deleteModelGateway();
      setGateway(null);
      setDraft(draftFrom(null));
      setRemoveOpen(false);
      setNotice(restartNotice("Model Gateway removed.", result.jobs));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove the Model Gateway.");
    } finally {
      setPending(null);
    }
  }

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
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

      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={kindId}>Gateway</FieldLabel>
          <Select
            items={kindItems}
            value={draft.kind}
            onValueChange={(value) => {
              const next = modelGatewayKindOptions.find((item) => item.value === value);
              if (next) update({ kind: next.value as ModelGatewayKind });
            }}
            disabled={pending !== null}
          >
            <SelectTrigger id={kindId} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                {kindItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription>{option.description}</FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor={baseUrlId}>Base URL</FieldLabel>
          <Input
            id={baseUrlId}
            value={draft.baseUrl}
            onChange={(event) => update({ baseUrl: event.target.value })}
            placeholder={option.baseUrlPlaceholder}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            disabled={pending !== null}
          />
          <FieldDescription>
            The OpenAI-compatible endpoint Agents call, usually ending in /v1. Eveland stores no key
            for it: each project sets its own AI_GATEWAY_API_KEY.
          </FieldDescription>
        </Field>
      </FieldGroup>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending !== null}>
          {pending === "save" ? <Spinner data-icon="inline-start" /> : null}
          {pending === "save" ? "Saving…" : "Save gateway"}
        </Button>
        {gateway !== null ? (
          <AlertDialog
            open={removeOpen}
            onOpenChange={(open) => {
              if (pending === null) setRemoveOpen(open);
            }}
          >
            <AlertDialogTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  className="ml-auto text-destructive"
                  disabled={pending !== null}
                />
              }
            >
              <Trash2Icon data-icon="inline-start" />
              Remove gateway
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove the Model Gateway?</AlertDialogTitle>
                <AlertDialogDescription>
                  Live Agent Deployments restart and call models as authored.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <form onSubmit={remove}>
                <AlertDialogFooter>
                  <AlertDialogCancel type="button" disabled={pending !== null}>
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction
                    type="submit"
                    variant="destructive"
                    disabled={pending !== null}
                  >
                    {pending === "remove" ? <Spinner data-icon="inline-start" /> : null}
                    {pending === "remove" ? "Removing…" : "Remove gateway"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </form>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </div>
    </form>
  );
}
