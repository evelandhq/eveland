"use client";

import { useState } from "react";
import { KeyRoundIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type { PlatformSecretProfile } from "@eveland/core/contracts";
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
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { deletePlatformSecretProfile, savePlatformSecretProfile } from "@/lib/client-api";
import { validatePlatformSecretProfileDraft, type PlatformSecretProfileDraft } from "@/lib/platform-secret-profile";

const kindItems = [
  { label: "Secret", value: "secret" },
  { label: "Variable", value: "variable" },
] as const;

const emptyEntry = (): PlatformSecretProfileDraft["entries"][number] => ({
  key: "",
  kind: "secret",
  value: "",
  configured: false,
});

export function PlatformSecretProfileSettings({ initialProfiles }: { initialProfiles: PlatformSecretProfile[] }) {
  const [profiles, setProfiles] = useState(initialProfiles);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [entries, setEntries] = useState<PlatformSecretProfileDraft["entries"]>([emptyEntry()]);
  const [pending, setPending] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function resetForm() {
    setEditingId(null);
    setName("");
    setEntries([emptyEntry()]);
  }

  function editProfile(profile: PlatformSecretProfile) {
    setEditingId(profile.id);
    setName(profile.name);
    setEntries(profile.entries.map((entry) => ({ ...entry, value: "" })));
    setError(null);
    setNotice(null);
  }

  function updateEntry(index: number, patch: Partial<PlatformSecretProfileDraft["entries"][number]>) {
    setEntries((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, ...patch } : entry));
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validated = validatePlatformSecretProfileDraft({ name, entries });
    if (!validated.ok) {
      setError(validated.error);
      return;
    }
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const result = await savePlatformSecretProfile({ id: editingId ?? undefined, ...validated.input });
      setProfiles((current) => [result.profile, ...current.filter((profile) => profile.id !== result.profile.id)]);
      setNotice(result.jobs.length > 0
        ? `Profile saved. ${result.jobs.length} live deployment restart${result.jobs.length === 1 ? "" : "s"} queued.`
        : "Profile saved. New processes and Agent requests will use the current revision.");
      resetForm();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the Secret Profile.");
    } finally {
      setPending(false);
    }
  }

  async function removeProfile(profileId: string) {
    setDeletingId(profileId);
    setError(null);
    try {
      const result = await deletePlatformSecretProfile(profileId);
      if (result.deleted) setProfiles((current) => current.filter((profile) => profile.id !== profileId));
      if (editingId === profileId) resetForm();
      setNotice(result.jobs.length > 0
        ? `Profile deleted. ${result.jobs.length} live deployment restart${result.jobs.length === 1 ? "" : "s"} queued.`
        : "Profile deleted.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete the Secret Profile.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <Card>
        <CardHeader>
          <CardTitle>Profiles</CardTitle>
          <CardDescription>Values are encrypted. Only entry names, kinds, configured state, and revision are returned.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
          {notice ? <Alert><AlertDescription>{notice}</AlertDescription></Alert> : null}
          {profiles.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon"><KeyRoundIcon /></EmptyMedia>
                <EmptyTitle>No Secret Profiles</EmptyTitle>
                <EmptyDescription>Create an operator-owned profile, then bind it to a Project or Deployment.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Entries</TableHead>
                  <TableHead>Revision</TableHead>
                  <TableHead><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {profiles.map((profile) => (
                  <TableRow key={profile.id}>
                    <TableCell className="font-medium">{profile.name}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {profile.entries.map((entry) => <Badge key={entry.key} variant="secondary">{entry.key}</Badge>)}
                      </div>
                    </TableCell>
                    <TableCell>r{profile.revision}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button type="button" variant="outline" size="sm" onClick={() => editProfile(profile)}>Edit</Button>
                        <AlertDialog>
                          <AlertDialogTrigger render={<Button type="button" variant="outline" size="sm" />}>
                            <Trash2Icon data-icon="inline-start" />
                            Delete
                          </AlertDialogTrigger>
                          <AlertDialogContent size="sm">
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete {profile.name}?</AlertDialogTitle>
                              <AlertDialogDescription>
                                All bindings will be removed. Affected live deployments will restart without these values.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                variant="destructive"
                                disabled={deletingId === profile.id}
                                onClick={() => void removeProfile(profile.id)}
                              >
                                {deletingId === profile.id ? <Spinner data-icon="inline-start" /> : null}
                                Delete profile
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{editingId ? "Edit profile" : "New profile"}</CardTitle>
          <CardDescription>Leave an existing value blank to keep its current encrypted value.</CardDescription>
        </CardHeader>
        <form onSubmit={submit}>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="secret-profile-name">Name</FieldLabel>
                <Input id="secret-profile-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Shared model credentials" />
              </Field>
              {entries.map((entry, index) => (
                <Field key={index}>
                  <FieldLabel>Entry {index + 1}</FieldLabel>
                  <div className="grid gap-2 sm:grid-cols-[1fr_8rem]">
                    <Input
                      aria-label={`Entry ${index + 1} key`}
                      value={entry.key}
                      onChange={(event) => updateEntry(index, { key: event.target.value.toUpperCase() })}
                      placeholder="OPENAI_API_KEY"
                    />
                    <Select
                      items={kindItems}
                      value={entry.kind}
                      onValueChange={(value) => {
                        if (value === "variable" || value === "secret") updateEntry(index, { kind: value });
                      }}
                    >
                      <SelectTrigger aria-label={`Entry ${index + 1} kind`} className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent alignItemWithTrigger={false}>
                        <SelectGroup>
                          {kindItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>
                  <Input
                    aria-label={`Entry ${index + 1} value`}
                    type={entry.kind === "secret" ? "password" : "text"}
                    autoComplete="new-password"
                    value={entry.value}
                    onChange={(event) => updateEntry(index, { value: event.target.value })}
                    placeholder={entry.configured ? "Configured — leave blank to keep" : "Value"}
                  />
                  {entry.configured ? <FieldDescription>Configured in revision; the value is not available to this browser.</FieldDescription> : null}
                  {entries.length > 1 ? (
                    <Button type="button" variant="ghost" size="sm" onClick={() => setEntries((current) => current.filter((_, entryIndex) => entryIndex !== index))}>
                      <Trash2Icon data-icon="inline-start" />
                      Remove entry
                    </Button>
                  ) : null}
                </Field>
              ))}
              <Button type="button" variant="outline" onClick={() => setEntries((current) => [...current, emptyEntry()])}>
                <PlusIcon data-icon="inline-start" />
                Add entry
              </Button>
            </FieldGroup>
          </CardContent>
          <CardFooter className="gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? <Spinner data-icon="inline-start" /> : null}
              {editingId ? "Save revision" : "Create profile"}
            </Button>
            {editingId ? <Button type="button" variant="outline" onClick={resetForm}>Cancel</Button> : null}
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
