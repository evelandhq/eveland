"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcwIcon, Trash2Icon } from "lucide-react";
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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { deleteProject } from "@/lib/client-api";

export function DeleteProjectAction({
  projectId,
  projectName,
  deletionStatus,
  appearance = "danger",
}: {
  projectId: string;
  projectName: string;
  deletionStatus: "deleting" | "failed" | null;
  appearance?: "card" | "danger";
}) {
  const router = useRouter();
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (deletionStatus === "deleting") {
    return (
      <Button type="button" size={appearance === "card" ? "icon-sm" : "default"} variant="outline" disabled>
        <Spinner data-icon="inline-start" />
        {appearance === "danger" ? "Deleting…" : <span className="sr-only">Deleting {projectName}</span>}
      </Button>
    );
  }

  const retry = deletionStatus === "failed";
  const confirmed = confirmation === projectName;
  const invalid = confirmation.length > 0 && !confirmed;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmed || pending) return;
    setPending(true);
    setError(null);
    try {
      await deleteProject(projectId);
      setOpen(false);
      router.replace("/projects");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Project deletion could not be requested.");
      setPending(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (pending) return;
        setOpen(nextOpen);
        if (!nextOpen) {
          setConfirmation("");
          setError(null);
        }
      }}
    >
      <AlertDialogTrigger
        render={
          <Button
            type="button"
            size={appearance === "card" ? "icon-sm" : "default"}
            variant="destructive"
            aria-label={`${retry ? "Retry deletion of" : "Delete"} ${projectName}`}
          />
        }
      >
        {retry ? <RotateCcwIcon data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}
        {appearance === "danger" ? (retry ? "Retry deletion" : "Delete project") : null}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{retry ? "Retry permanent deletion?" : "Permanently delete this project?"}</AlertDialogTitle>
          <AlertDialogDescription>
            This stops every deployment and removes routes, source snapshots, releases, sessions, usage, secrets, logs,
            telemetry data, and sandbox workspaces. This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <form className="flex flex-col gap-6" onSubmit={submit}>
          <FieldGroup>
            <Field data-invalid={invalid || Boolean(error)}>
              <FieldLabel htmlFor={inputId}>Type the project name to confirm</FieldLabel>
              <Input
                id={inputId}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                placeholder={projectName}
                autoComplete="off"
                aria-invalid={invalid || Boolean(error)}
                disabled={pending}
              />
              <FieldDescription>
                Enter <strong>{projectName}</strong> exactly.
              </FieldDescription>
              {error ? <FieldError>{error}</FieldError> : null}
            </Field>
          </FieldGroup>
          <AlertDialogFooter>
            <AlertDialogCancel type="button" disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction type="submit" variant="destructive" disabled={!confirmed || pending}>
              {pending ? <Spinner data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}
              {pending ? "Requesting deletion…" : retry ? "Retry deletion" : "Delete permanently"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
