"use client";

import { useId, useState } from "react";
import { LockKeyholeIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type { SharedAgentEnvironment } from "@eveland/core/contracts";
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { saveSharedAgentEnvironment } from "@/lib/client-api";
import {
  validateSharedAgentEnvironmentDraft,
  updateSharedAgentEnvironmentEntry,
  type SharedAgentEnvironmentDraft,
} from "@/lib/shared-agent-environment";

type EnvironmentEntry = SharedAgentEnvironmentDraft["entries"][number];

const kindItems = [
  { label: "Secret", value: "secret" },
  { label: "Variable", value: "variable" },
] as const;

const emptyEntry = (): EnvironmentEntry => ({
  key: "",
  kind: "secret",
  value: "",
  configured: false,
});

export function SharedAgentEnvironmentSettings({
  initialEnvironment,
}: {
  initialEnvironment: SharedAgentEnvironment | null;
}) {
  const keyId = useId();
  const kindId = useId();
  const valueId = useId();
  const [environment, setEnvironment] = useState(initialEnvironment);
  const [entries, setEntries] = useState<EnvironmentEntry[]>(
    initialEnvironment?.entries.map((entry) => ({ ...entry, value: "" })) ?? [],
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [entryDraft, setEntryDraft] = useState<EnvironmentEntry>(emptyEntry);
  const [deleteIndex, setDeleteIndex] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function openAddDialog() {
    setEditingIndex(null);
    setEntryDraft(emptyEntry());
    setDialogError(null);
    setDialogOpen(true);
  }

  function openEditDialog(index: number) {
    setEditingIndex(index);
    setEntryDraft({ ...entries[index]! });
    setDialogError(null);
    setDialogOpen(true);
  }

  function updateDraft(patch: Partial<EnvironmentEntry>) {
    setEntryDraft((current) => updateSharedAgentEnvironmentEntry(current, patch));
    setDialogError(null);
  }

  async function persistEntries(
    nextEntries: EnvironmentEntry[],
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const validated = validateSharedAgentEnvironmentDraft({ entries: nextEntries });
    if (!validated.ok) {
      setError(validated.error);
      return { ok: false, error: validated.error };
    }

    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const result = await saveSharedAgentEnvironment(validated.input.entries);
      setEnvironment(result.environment);
      setEntries(result.environment.entries.map((entry) => ({ ...entry, value: "" })));
      setNotice(
        result.jobs.length > 0
          ? `Shared environment saved. ${result.jobs.length} live deployment restart${result.jobs.length === 1 ? "" : "s"} queued.`
          : "Shared environment saved. Agent Deployments will use it the next time their process starts.",
      );
      return { ok: true };
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Could not save the shared Agent environment.";
      setError(message);
      return { ok: false, error: message };
    } finally {
      setPending(false);
    }
  }

  async function submitEntry(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextEntries =
      editingIndex === null
        ? [...entries, entryDraft]
        : entries.map((entry, index) => (index === editingIndex ? entryDraft : entry));
    const validated = validateSharedAgentEnvironmentDraft({ entries: nextEntries });
    if (!validated.ok) {
      setDialogError(validated.error);
      return;
    }
    const result = await persistEntries(nextEntries);
    if (result.ok) setDialogOpen(false);
    else setDialogError(result.error);
  }

  async function deleteEntry(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (deleteIndex === null) return;
    const result = await persistEntries(entries.filter((_, index) => index !== deleteIndex));
    if (result.ok) setDeleteIndex(null);
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Variables and secrets</CardTitle>
          <CardDescription>
            Shared fallback values are encrypted and applied to every Agent Deployment. Project
            Secrets take precedence.
          </CardDescription>
          <CardAction>
            <Button
              type="button"
              size="sm"
              onClick={openAddDialog}
              disabled={pending || entries.length >= 50}
            >
              <PlusIcon data-icon="inline-start" />
              Add entry
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {notice ? (
            <Alert>
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
            <span>Values are never returned to the browser after saving.</span>
            <span className="shrink-0 tabular-nums">
              {environment ? `Revision r${environment.revision}` : "Not configured"}
            </span>
          </div>
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-32">Type</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead className="w-24">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.length === 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={4}>
                      <Empty className="border-0 py-10">
                        <EmptyHeader>
                          <EmptyMedia variant="icon">
                            <LockKeyholeIcon />
                          </EmptyMedia>
                          <EmptyTitle>No shared entries</EmptyTitle>
                          <EmptyDescription>
                            Add a variable or secret to make it available to every Agent Deployment.
                          </EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    </TableCell>
                  </TableRow>
                ) : (
                  entries.map((entry, index) => (
                    <TableRow key={`${entry.key}-${entry.kind}`}>
                      <TableCell>
                        <Badge variant="secondary">
                          {entry.kind === "secret" ? "Secret" : "Variable"}
                        </Badge>
                      </TableCell>
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
                            onClick={() => openEditDialog(index)}
                          >
                            <PencilIcon />
                          </Button>
                          <AlertDialog
                            open={deleteIndex === index}
                            onOpenChange={(open) => {
                              if (!pending) setDeleteIndex(open ? index : null);
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
                                  This removes the shared value and restarts live Agent Deployments
                                  so it no longer applies.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <form onSubmit={deleteEntry}>
                                <AlertDialogFooter>
                                  <AlertDialogCancel type="button" disabled={pending}>
                                    Cancel
                                  </AlertDialogCancel>
                                  <AlertDialogAction
                                    type="submit"
                                    variant="destructive"
                                    disabled={pending}
                                  >
                                    {pending ? (
                                      <Spinner data-icon="inline-start" />
                                    ) : (
                                      <Trash2Icon data-icon="inline-start" />
                                    )}
                                    {pending ? "Removing…" : "Remove entry"}
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </form>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!pending) setDialogOpen(open);
          if (!open) setDialogError(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingIndex === null ? "Add entry" : "Edit entry"}</DialogTitle>
            <DialogDescription>
              {editingIndex === null
                ? "Create a shared runtime value for every Agent Deployment."
                : "Update the entry identity or provide a new value to rotate it."}
            </DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-6" onSubmit={submitEntry}>
            {dialogError ? (
              <Alert variant="destructive">
                <AlertDescription>{dialogError}</AlertDescription>
              </Alert>
            ) : null}
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={kindId}>Type</FieldLabel>
                <Select
                  items={kindItems}
                  value={entryDraft.kind}
                  onValueChange={(value) => {
                    if (value === "variable" || value === "secret") updateDraft({ kind: value });
                  }}
                  disabled={pending}
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
              </Field>
              <Field>
                <FieldLabel htmlFor={keyId}>Name</FieldLabel>
                <Input
                  id={keyId}
                  value={entryDraft.key}
                  onChange={(event) => updateDraft({ key: event.target.value.toUpperCase() })}
                  placeholder="OPENAI_API_KEY"
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  disabled={pending}
                />
                <FieldDescription>
                  Use uppercase letters, numbers, and underscores.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor={valueId}>Value</FieldLabel>
                <Input
                  id={valueId}
                  type={entryDraft.kind === "secret" ? "password" : "text"}
                  autoComplete="new-password"
                  value={entryDraft.value}
                  onChange={(event) => updateDraft({ value: event.target.value })}
                  placeholder={
                    entryDraft.configured
                      ? "Leave blank to keep the current value"
                      : "Enter a value"
                  }
                  disabled={pending}
                />
                {entryDraft.configured ? (
                  <FieldDescription>
                    Configured; the current value is not available to this browser.
                  </FieldDescription>
                ) : null}
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => setDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? <Spinner data-icon="inline-start" /> : null}
                {pending ? "Saving…" : editingIndex === null ? "Add entry" : "Save changes"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
