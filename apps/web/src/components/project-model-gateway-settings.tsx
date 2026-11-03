"use client";

import { useId, useState } from "react";
import { CheckCircle2Icon, RefreshCwIcon } from "lucide-react";
import type { ProjectModelGatewayMode } from "@evelandhq/core/model-gateway";
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
import { rotateProjectModelGatewayKey, saveProjectModelGateway } from "@/lib/client-api";
import {
  modelGatewayKindOption,
  projectModelGatewayKeySummary,
  projectModelGatewayModeOptions,
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
  const keyId = useId();
  const [settings, setSettings] = useState(initial.settings);
  const [mode, setMode] = useState<ProjectModelGatewayMode>(initial.settings.mode);
  const [projectKey, setProjectKey] = useState("");
  const [pending, setPending] = useState<"save" | "rotate" | null>(null);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const gateway = initial.gateway;
  const modeOption = projectModelGatewayModeOptions.find((option) => option.value === mode)!;
  const canRotate =
    gateway?.issuesProjectKeys === true &&
    settings.mode === "platform" &&
    settings.issuedKey?.state === "registered";

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (mode === "project-key" && projectKey.trim() === "" && !settings.projectKeyConfigured) {
      setError("Enter the project's Model Gateway key.");
      return;
    }
    setPending("save");
    setError(null);
    setNotice(null);
    try {
      const result = await saveProjectModelGateway(projectId, {
        mode,
        ...(mode === "project-key" && projectKey.trim() !== ""
          ? { projectKey: projectKey.trim() }
          : {}),
      });
      setSettings(result.settings);
      setProjectKey("");
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
      setPending(null);
    }
  }

  async function rotate(event: React.FormEvent) {
    event.preventDefault();
    event.stopPropagation();
    setPending("rotate");
    setError(null);
    setNotice(null);
    try {
      await rotateProjectModelGatewayKey(projectId);
      setRotateOpen(false);
      setNotice(
        "Key rotation queued. Live deployments restart onto the new key; the old key keeps working for an hour.",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not rotate the key.");
    } finally {
      setPending(null);
    }
  }

  return (
    <section aria-labelledby="project-model-gateway-heading" className="flex flex-col gap-5">
      <div>
        <h3 id="project-model-gateway-heading" className="text-base font-semibold">
          Model Gateway
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {gateway === null
            ? projectModelGatewayKeySummary(settings, gateway)
            : `Routes this project's string model IDs through the instance's ${modelGatewayKindOption(gateway.kind).label} gateway. ${projectModelGatewayKeySummary(settings, gateway)}`}
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

      <form className="flex flex-col gap-5" onSubmit={save}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={modeId}>Key</FieldLabel>
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
              disabled={pending !== null}
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
            <FieldDescription>{modeOption.description}</FieldDescription>
          </Field>
          {mode === "project-key" ? (
            <Field>
              <FieldLabel htmlFor={keyId}>Project key</FieldLabel>
              <Input
                id={keyId}
                type="password"
                value={projectKey}
                onChange={(event) => setProjectKey(event.target.value)}
                placeholder={
                  settings.projectKeyConfigured ? "Configured — leave blank to keep" : ""
                }
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                disabled={pending !== null}
              />
              <FieldDescription>
                Stored encrypted and delivered only to this project&apos;s running deployments.
              </FieldDescription>
            </Field>
          ) : null}
        </FieldGroup>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={pending !== null}>
            {pending === "save" ? <Spinner data-icon="inline-start" /> : null}
            {pending === "save" ? "Saving…" : "Save"}
          </Button>
          {canRotate ? (
            <AlertDialog
              open={rotateOpen}
              onOpenChange={(open) => {
                if (pending === null) setRotateOpen(open);
              }}
            >
              <AlertDialogTrigger
                render={<Button type="button" variant="outline" disabled={pending !== null} />}
              >
                <RefreshCwIcon data-icon="inline-start" />
                Rotate key
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Rotate this project&apos;s key?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Eveland replaces {settings.issuedKey?.alias} with a new key and restarts the
                    project&apos;s live deployments onto it. The old key keeps working for an hour.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <form onSubmit={rotate}>
                  <AlertDialogFooter>
                    <AlertDialogCancel type="button" disabled={pending !== null}>
                      Cancel
                    </AlertDialogCancel>
                    <AlertDialogAction type="submit" disabled={pending !== null}>
                      {pending === "rotate" ? <Spinner data-icon="inline-start" /> : null}
                      {pending === "rotate" ? "Rotating…" : "Rotate key"}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </form>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}
        </div>
      </form>
    </section>
  );
}
