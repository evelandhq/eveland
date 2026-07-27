"use client";

import { useId, useState } from "react";
import { LockKeyholeIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  createProjectEnvironmentEntry,
  deleteProjectEnvironmentEntry,
  updateProjectEnvironmentEntry,
} from "@/lib/client-api";
import type { PublicSecret } from "@/lib/api";
import {
  validateProjectEnvironmentEntry,
  type ProjectEnvironmentEntryDraft,
} from "@/lib/project-secrets";

const kindItems = [
  { label: "Secret", value: "secret" },
  { label: "Variable", value: "variable" },
] as const;

const emptyEntry = (): ProjectEnvironmentEntryDraft => ({
  key: "",
  kind: "secret",
  value: "",
  configured: false,
});

function restartNotice(action: string, jobs: unknown[]): string {
  return jobs.length > 0
    ? `${action} ${jobs.length} live deployment restart${jobs.length === 1 ? "" : "s"} queued.`
    : `${action} It will apply the next time this project starts.`;
}

export function ProjectSecretsSettings({
  projectId,
  initialEntries,
}: {
  projectId: string;
  initialEntries: PublicSecret[];
}) {
  const kindId = useId();
  const keyId = useId();
  const valueId = useId();
  const [entries, setEntries] = useState(initialEntries);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<PublicSecret | null>(null);
  const [draft, setDraft] = useState<ProjectEnvironmentEntryDraft>(emptyEntry);
  const [deleteEntry, setDeleteEntry] = useState<PublicSecret | null>(null);
  const [pending, setPending] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function openAddDialog() {
    setEditingEntry(null);
    setDraft(emptyEntry());
    setDialogError(null);
    setDialogOpen(true);
  }

  function openEditDialog(entry: PublicSecret) {
    setEditingEntry(entry);
    setDraft({ key: entry.key, kind: entry.kind, value: "", configured: true });
    setDialogError(null);
    setDialogOpen(true);
  }

  async function submitEntry(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validated = validateProjectEnvironmentEntry(
      draft,
      entries.map((entry) => entry.key),
      editingEntry?.key,
    );
    if (!validated.ok) {
      setDialogError(validated.error);
      return;
    }
    if (!editingEntry && validated.input.value === undefined) {
      setDialogError(`Enter a value for ${validated.input.key}.`);
      return;
    }

    setPending(true);
    setDialogError(null);
    setError(null);
    setNotice(null);
    try {
      const result = editingEntry
        ? await updateProjectEnvironmentEntry(projectId, editingEntry.id, validated.input)
        : await createProjectEnvironmentEntry(projectId, {
            ...validated.input,
            value: validated.input.value!,
          });
      setEntries((current) => editingEntry
        ? current.map((entry) => entry.id === result.secret.id ? result.secret : entry)
        : [result.secret, ...current]);
      setNotice(restartNotice(editingEntry ? "Entry updated." : "Entry added.", result.jobs));
      setDialogOpen(false);
    } catch (caught) {
      setDialogError(caught instanceof Error ? caught.message : "Environment entry could not be saved.");
    } finally {
      setPending(false);
    }
  }

  async function removeEntry(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!deleteEntry) return;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const result = await deleteProjectEnvironmentEntry(projectId, deleteEntry.id);
      if (!result.deleted) throw new Error("Environment entry was not found.");
      setEntries((current) => current.filter((entry) => entry.id !== deleteEntry.id));
      setNotice(restartNotice("Entry removed.", result.jobs));
      setDeleteEntry(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Environment entry could not be removed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <section
        aria-labelledby="variables-secrets-heading"
        className="flex min-w-0 flex-col gap-5"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 id="variables-secrets-heading" className="font-medium">
              Variables and secrets
            </h3>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Values are encrypted and never returned after saving. Saving changes restarts live deployments; otherwise, they apply the next time this project starts.
            </p>
          </div>
          <Button type="button" size="sm" onClick={openAddDialog} disabled={pending || entries.length >= 50}>
            <PlusIcon data-icon="inline-start" />
            Add entry
          </Button>
        </div>
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        {notice ? <Alert><AlertDescription>{notice}</AlertDescription></Alert> : null}
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-32">Type</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Value</TableHead>
                <TableHead className="w-24"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={4}>
                    <Empty className="border-0 py-10">
                      <EmptyHeader>
                        <EmptyMedia variant="icon"><LockKeyholeIcon /></EmptyMedia>
                        <EmptyTitle>No project entries</EmptyTitle>
                        <EmptyDescription>Add a variable or secret for this project&apos;s Agent runtime.</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  </TableCell>
                </TableRow>
              ) : entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell><Badge variant="secondary">{entry.kind === "secret" ? "Secret" : "Variable"}</Badge></TableCell>
                  <TableCell className="font-mono text-xs font-medium">{entry.key}</TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-2 text-muted-foreground">
                      <LockKeyholeIcon className="size-4" />
                      Configured
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit entry ${entry.key}`}
                        title="Edit entry"
                        disabled={pending}
                        onClick={() => openEditDialog(entry)}
                      >
                        <PencilIcon />
                      </Button>
                      <AlertDialog
                        open={deleteEntry?.id === entry.id}
                        onOpenChange={(open) => {
                          if (!pending) setDeleteEntry(open ? entry : null);
                        }}
                      >
                        <AlertDialogTrigger
                          render={
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Remove entry ${entry.key}`}
                              title="Remove entry"
                              disabled={pending}
                            />
                          }
                        >
                          <Trash2Icon />
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Remove {entry.key}?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This removes the runtime value and restarts live deployments so it no longer applies.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <form onSubmit={removeEntry}>
                            <AlertDialogFooter>
                              <AlertDialogCancel type="button" disabled={pending}>Cancel</AlertDialogCancel>
                              <AlertDialogAction type="submit" variant="destructive" disabled={pending}>
                                {pending ? <Spinner data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}
                                {pending ? "Removing…" : "Remove entry"}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </form>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!pending) setDialogOpen(open);
          if (!open) setDialogError(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingEntry ? "Edit entry" : "Add entry"}</DialogTitle>
            <DialogDescription>
              {editingEntry
                ? "Update its type or name, and optionally enter a new value."
                : "Add runtime configuration for this project's Agent."}
            </DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-6" onSubmit={submitEntry}>
            {dialogError ? <Alert variant="destructive"><AlertDescription>{dialogError}</AlertDescription></Alert> : null}
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={kindId}>Type</FieldLabel>
                <Select
                  items={kindItems}
                  value={draft.kind}
                  onValueChange={(value) => {
                    if (value === "variable" || value === "secret") setDraft((current) => ({ ...current, kind: value }));
                  }}
                  disabled={pending}
                >
                  <SelectTrigger id={kindId} className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {kindItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor={keyId}>Name</FieldLabel>
                <Input
                  id={keyId}
                  value={draft.key}
                  onChange={(event) => setDraft((current) => ({ ...current, key: event.target.value.toUpperCase() }))}
                  placeholder="OPENAI_API_KEY"
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  disabled={pending}
                />
                <FieldDescription>Use uppercase letters, numbers, and underscores.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor={valueId}>Value</FieldLabel>
                <Input
                  id={valueId}
                  type={draft.kind === "secret" ? "password" : "text"}
                  autoComplete="new-password"
                  value={draft.value}
                  onChange={(event) => setDraft((current) => ({ ...current, value: event.target.value }))}
                  placeholder={draft.configured ? "Leave blank to keep the current value" : "Enter a value"}
                  disabled={pending}
                />
                {draft.configured ? (
                  <FieldDescription>Configured; the current value is not available to this browser.</FieldDescription>
                ) : null}
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={pending} onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={pending}>
                {pending ? <Spinner data-icon="inline-start" /> : null}
                {pending ? "Saving…" : editingEntry ? "Save changes" : "Add entry"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
